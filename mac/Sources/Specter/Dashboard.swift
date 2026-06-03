import AppKit
import SwiftUI
import Foundation

/// Spec: tasks/spec-multi-cms-ui.md — S3 Dashboard (the Stitch hero screen).
///
/// New top-level window for multi-target management. Wired to live data:
/// `DashboardController` reads `~/.config/ghost-sync/config.json` and
/// `~/.local/state/ghost-sync/state.json` and refreshes on a 5-second poll
/// (matches `StatusStore`). The view-model `SyncTarget` is derived from each
/// `TargetConfig` in `config.targets[]`.
///
/// State derivation rules (mirrors `tasks/_active.md` "Replace Dashboard mock
/// data with daemon-backed reads"):
///
///   - `connectionState`: a target is "connected" when its adapter credentials
///     are non-empty (Ghost: ghostUrl + adminApiKey; Shopify: shop +
///     accessToken). Otherwise "not connected".
///   - `lastSyncedAt` / `lastSyncedRelative`: read from `state.json`. The
///     state file today carries a single global `lastSyncAt` (no per-target
///     field). For single-target configs this is reused; for multi-target
///     configs each target shows "not synced yet" until a per-target schema
///     lands. See `tasks/_active.md` "Open Questions" → per-target sync state.
///   - `conflictCount`: same global-vs-per-target story. Single target uses
///     `state.json.lastConflicts`; multi-target falls back to 0.

@MainActor
final class DashboardController: ObservableObject {
    enum Section: String, CaseIterable, Identifiable {
        case targets, activity, conflicts, settings
        var id: String { rawValue }
        var label: String {
            switch self {
            case .targets:   return "Connections"
            case .activity:  return "Sync Logs"
            case .conflicts: return "Conflicts"
            case .settings:  return "Settings"
            }
        }
        var icon: String {
            switch self {
            case .targets:   return "square.stack.3d.up"
            case .activity:  return "waveform.path"
            case .conflicts: return "exclamationmark.triangle"
            case .settings:  return "gearshape"
            }
        }
    }

    @Published var section: Section = .targets

    /// Live view-model derived from `config.targets[]` + `state.json`. Empty
    /// when no config exists yet (clean install before onboarding).
    @Published var targets: [SyncTarget] = []
    @Published var state: DaemonState?

    /// Global (app-level) preferences surfaced in the Settings pane. These are
    /// the only settings that aren't per-connection: the vault root, the OAuth
    /// broker override, and (via `LoginItem`) launch-at-login. Per-connection
    /// sync mode / conflict strategy / content kinds live on each connection,
    /// never here — that was the "prefs shouldn't mention a specific Ghost
    /// instance" feedback.
    @Published var vaultPath: String = ""
    @Published var oauthBaseUrl: String = ""

    @Published var isFreeTier: Bool = false

    /// Set by `SpecterApp.body` once both controllers exist so the per-card
    /// actions can talk to the daemon and refresh status without each
    /// callsite re-resolving them. Optional so unit/SwiftUI previews still
    /// construct a `DashboardController()` without dependencies.
    weak var statusStore: StatusStore?
    weak var supervisor: DaemonSupervisor?
    /// Connect-form controllers, so per-card / Settings "Edit" can pre-fill the
    /// matching platform form before its window opens. Optional for previews.
    weak var ghostConnect: GhostConnectController?
    weak var wordpressConnect: WordPressConnectController?
    weak var shopifyConnect: ShopifyConnectController?
    weak var webflowConnect: WebflowConnectController?

    func configure(store: StatusStore, supervisor: DaemonSupervisor) {
        self.statusStore = store
        self.supervisor = supervisor
    }

    func configure(
        store: StatusStore,
        supervisor: DaemonSupervisor,
        ghostConnect: GhostConnectController,
        wordpressConnect: WordPressConnectController,
        shopifyConnect: ShopifyConnectController,
        webflowConnect: WebflowConnectController
    ) {
        self.statusStore = store
        self.supervisor = supervisor
        self.ghostConnect = ghostConnect
        self.wordpressConnect = wordpressConnect
        self.shopifyConnect = shopifyConnect
        self.webflowConnect = webflowConnect
    }

    private var timer: Timer?

    /// Begin polling. Mirrors `StatusStore.start()` — same cadence so the two
    /// surfaces stay coherent without introducing a second clock. Idempotent:
    /// safe to call from `.onAppear` when the window is reopened.
    func start() {
        reload()
        guard timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.reload() }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    /// Read `config.json` + `state.json` once and rebuild the view-model.
    func reload() {
        let config = ConfigStore.load()
        let state = loadDaemonState()
        self.state = state
        self.targets = buildTargets(config: config, state: state)
        self.vaultPath = config?.vaultPath ?? ""
        self.oauthBaseUrl = config?.oauthBaseUrl ?? ""
    }

    /// Load → mutate → save the config, restart the daemon so the change takes
    /// effect, and refresh. Used by the Settings pane's global-pref editors.
    private func updateConfig(_ mutate: (inout DaemonConfig) -> Void) {
        guard var cfg = ConfigStore.load() else { return }
        mutate(&cfg)
        do {
            try ConfigStore.save(cfg)
            supervisor?.restart()
            reload()
        } catch {
            MenuActions.notify("Specter", "Couldn't save settings: \(error.localizedDescription)")
        }
    }

    /// Choose a new vault root from the Settings pane.
    func pickVaultFolder() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Choose Folder"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        updateConfig { $0.vaultPath = url.standardizedFileURL.path }
    }

    /// Persist the OAuth broker override (empty → nil, i.e. use the hosted default).
    func saveOAuthBaseUrl(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        updateConfig { $0.oauthBaseUrl = trimmed.isEmpty ? nil : trimmed }
    }

    func openSyncFolder() {
        guard !vaultPath.isEmpty else { return }
        NSWorkspace.shared.open(URL(fileURLWithPath: vaultPath))
    }

    func openLogs() {
        NSWorkspace.shared.open(Paths.logPath)
    }

    /// Per-card action dispatch: spawn the daemon with the requested
    /// subcommand scoped to one target, then force a reload so the card
    /// updates without waiting for the 5-second poll.
    ///
    /// `kind` mirrors the buttons rendered by `SyncCard`:
    ///   .pull   → `pull   --target <handle>`
    ///   .push   → `push   --target <handle>`
    ///   .sync   → `sync   --target <handle>`            (not yet exposed in UI; reserved)
    func runAction(_ kind: TargetAction, handle: String) {
        // Diagnostic — NSLog wasn't surfacing in the unified log for the
        // installed Specter.app. File append always works regardless of
        // logging policy, so a single `tail /tmp/specter-dashboard-debug.log`
        // tells us whether clicks are even reaching this method.
        debugLog("runAction kind=\(kind) handle=\(handle) statusStore=\(statusStore == nil ? "nil" : "set")")

        guard let store = statusStore else {
            // Don't fail silently — alert so the user knows the click landed
            // somewhere even when the wiring is wrong.
            DispatchQueue.main.async {
                let alert = NSAlert()
                alert.messageText = "Dashboard click reached runAction"
                alert.informativeText = "But statusStore is nil — daemon spawn is disabled. This is a wiring bug. Please file an issue with the steps that triggered it."
                alert.runModal()
            }
            return
        }
        let subcommand: String
        var dryRun = false
        switch kind {
        case .pull:   subcommand = "pull"
        case .push:   subcommand = "push"
        case .sync:   subcommand = "sync"
        case .dryRun: subcommand = "sync"; dryRun = true
        }
        debugLog("dispatching MenuActions.runForTarget subcommand=\(subcommand) handle=\(handle) dryRun=\(dryRun)")
        MenuActions.runForTarget(
            subcommand,
            targetHandle: handle,
            store: store,
            dryRun: dryRun,
            onComplete: { [weak self] succeeded in
                self?.debugLog("MenuActions.runForTarget completion succeeded=\(succeeded)")
                // Always refresh, success or failure, so the card mirrors the
                // post-run state (last-sync timestamp, conflict count, error
                // status) without waiting for the StatusStore poll.
                self?.reload()
            }
        )
    }

    private func debugLog(_ message: String) {
        let line = "\(ISO8601DateFormatter().string(from: Date())) \(message)\n"
        let path = "/tmp/specter-dashboard-debug.log"
        guard let data = line.data(using: .utf8) else { return }
        if let fh = try? FileHandle(forWritingTo: URL(fileURLWithPath: path)) {
            fh.seekToEndOfFile()
            try? fh.write(contentsOf: data)
            try? fh.close()
        } else {
            try? data.write(to: URL(fileURLWithPath: path))
        }
    }

    /// Persist the auto-sync toggle. Atomic write via
    /// `ConfigStore.setSyncMode(...)`; daemon restart picks up the new mode
    /// for the watcher.
    func setAutoSync(handle: String, enabled: Bool) {
        let mode = enabled ? "auto" : "manual"
        do {
            let ok = try ConfigStore.setSyncMode(handle: handle, mode: mode)
            guard ok else {
                MenuActions.notify("Specter",
                                   "Couldn't update auto-sync — config target not found.")
                reload()
                return
            }
        } catch {
            MenuActions.notify("Specter",
                               "Couldn't save auto-sync change: \(error.localizedDescription)")
            reload()
            return
        }
        // Daemon already running? Restart so the watcher picks up the new
        // syncMode without the user having to relaunch the app. Safe to call
        // even when not running (restart() guards via stop()).
        supervisor?.restart()
        // Transient confirmation — matches the menu-bar "Silent success is
        // the worst UX" rule.
        MenuActions.notify("Specter",
                           "Auto-sync \(enabled ? "enabled" : "paused") for \(handle).")
        reload()
    }

    enum TargetAction { case pull, push, sync, dryRun }

    /// Find the configured target by handle (the dashboard view-model only
    /// carries display fields, so Edit/Remove re-read the real config).
    private func configTarget(handle: String) -> TargetConfig? {
        ConfigStore.load()?.targets?.first(where: { $0.handle == handle })
    }

    /// Pre-fill the matching per-platform connect form and return the window id
    /// to open, or nil for platforms with no in-app edit form (Shopify is
    /// re-authorized through the web OAuth flow, not a local form). Caller
    /// (the view) performs `openWindow(id:)` because window opening needs the
    /// SwiftUI environment.
    func prepareEdit(handle: String) -> String? {
        guard let target = configTarget(handle: handle) else { return nil }
        switch target.adapter {
        case .ghost:
            ghostConnect?.loadForEditing(target)
            return "ghost-connect"
        case .wordpress:
            wordpressConnect?.loadForEditing(target)
            return "wordpress-connect"
        case .shopify:
            // Credentials are re-authorized via the web flow, but content-kind
            // selection (and the label) are editable in-app.
            shopifyConnect?.loadForEditing(target)
            return "shopify-connect"
        case .webflow:
            webflowConnect?.loadForEditing(target)
            return "webflow-connect"
        }
    }

    /// Remove a target from `config.targets[]` and re-save. Vault files stay on
    /// disk. Restarts the daemon so the watcher drops the removed folder, then
    /// reloads the dashboard.
    func removeTarget(handle: String) {
        let confirm = NSAlert()
        confirm.messageText = "Disconnect \(handle)?"
        confirm.informativeText = "This removes the connection from Specter. Your local markdown files are left untouched."
        confirm.addButton(withTitle: "Disconnect")
        confirm.addButton(withTitle: "Cancel")
        guard confirm.runModal() == .alertFirstButtonReturn else { return }
        do {
            let ok = try ConfigStore.removeTarget(handle: handle)
            if !ok {
                MenuActions.notify("Specter", "Couldn't remove \(handle) — target not found.")
            } else {
                MenuActions.notify("Specter", "Disconnected \(handle).")
            }
        } catch {
            MenuActions.notify("Specter", "Couldn't remove \(handle): \(error.localizedDescription)")
        }
        supervisor?.restart()
        reload()
    }

    /// Run `test --target <handle>` so the user can verify a connection from
    /// the card menu without leaving the dashboard.
    func testTarget(handle: String) {
        guard let store = statusStore else { return }
        MenuActions.runForTarget("test", targetHandle: handle, store: store)
    }

    /// Load `state.json` using the same decoder as `StatusStore`. Returns nil
    /// if the file isn't there yet (daemon hasn't run).
    private func loadDaemonState() -> DaemonState? {
        guard let data = try? Data(contentsOf: Paths.statePath) else { return nil }
        return try? JSONDecoder().decode(DaemonState.self, from: data)
    }

    /// Compose one `SyncTarget` per configured `TargetConfig`. Single-target
    /// configs reuse the global last-sync timestamp + conflict count from
    /// `state.json`; multi-target configs show "not synced yet" per target
    /// because `state.json` doesn't carry per-target sync state yet.
    private func buildTargets(config: DaemonConfig?, state: DaemonState?) -> [SyncTarget] {
        guard let config = config, let targets = config.targets, !targets.isEmpty else {
            return []
        }
        let isMulti = targets.count > 1
        return targets.map { tc in
            let platform = platformOf(tc.adapter)
            let connected = hasCredentials(tc.adapter)
            let siteUrl = siteUrlOf(tc.adapter)
            let summary = summaryFor(target: tc, isMulti: isMulti)

            // Per-target sync state: prefer state.targets[handle] (written by
            // the daemon since v0.5.1) so each card shows its own last-sync
            // time and status. Fall back to the global counters for
            // single-target configs where per-target entries may not exist yet.
            let lastSyncedRelative: String?
            let conflictCount: Int
            let derivedState: SyncTarget.State

            if !connected {
                lastSyncedRelative = nil
                conflictCount = 0
                derivedState = .disconnected
            } else if let perTarget = state?.targets?[tc.handle] {
                // Per-target state.json entry — always prefer this when present.
                let lastSyncedAt = perTarget.lastSyncAt.flatMap {
                    ISO8601DateFormatter().date(from: $0)
                }
                lastSyncedRelative = relativeString(from: lastSyncedAt)
                conflictCount = perTarget.lastConflicts ?? 0
                derivedState = stateFromPerTarget(perTarget, conflictCount: conflictCount)
            } else {
                // Fallback: single-target config or first run before per-target
                // state has been written. Reuse the global counters as before.
                let lastSyncedAt = state?.lastSyncAt.flatMap {
                    ISO8601DateFormatter().date(from: $0)
                }
                lastSyncedRelative = relativeString(from: lastSyncedAt)
                conflictCount = state?.lastConflicts ?? 0
                derivedState = stateFromGlobal(state, conflictCount: conflictCount)
            }

            return SyncTarget(
                id: tc.handle,
                platform: platform,
                siteUrl: siteUrl,
                state: derivedState,
                lastSyncedRelative: lastSyncedRelative,
                summary: summary,
                autoSync: tc.syncMode == "auto",
                conflictCount: conflictCount,
                label: tc.label,
                contentKinds: tc.contentKinds
            )
        }
    }

    private func platformOf(_ adapter: AdapterConfig) -> Platform {
        switch adapter {
        case .ghost:     return .ghost
        case .shopify:   return .shopify
        case .wordpress: return .wordpress
        case .webflow:   return .webflow
        }
    }

    private func hasCredentials(_ adapter: AdapterConfig) -> Bool {
        switch adapter {
        case .ghost(let g):
            return !g.ghostUrl.isEmpty && !g.adminApiKey.isEmpty
        case .shopify(let s):
            return !s.shop.isEmpty && !s.accessToken.isEmpty
        case .wordpress(let w):
            return !w.siteUrl.isEmpty && !w.username.isEmpty && !w.appPassword.isEmpty
        case .webflow(let wf):
            let hasToken = !(wf.apiToken ?? "").isEmpty || !(wf.accessToken ?? "").isEmpty
            return !wf.siteId.isEmpty && hasToken
        }
    }

    private func siteUrlOf(_ adapter: AdapterConfig) -> String {
        switch adapter {
        case .ghost(let g):
            return displayHost(g.ghostUrl)
        case .shopify(let s):
            return s.shop.isEmpty ? "—" : s.shop
        case .wordpress(let w):
            return displayHost(w.siteUrl)
        case .webflow(let wf):
            return wf.siteId.isEmpty ? "—" : "webflow:\(wf.siteId)"
        }
    }

    /// Strip scheme + trailing slash so the card matches the spec's
    /// "example.ghost.io" rendering rather than full URL.
    private func displayHost(_ raw: String) -> String {
        if raw.isEmpty { return "—" }
        var s = raw
        if let r = s.range(of: "://") { s.removeSubrange(s.startIndex..<r.upperBound) }
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }

    private func summaryFor(target: TargetConfig, isMulti: Bool) -> String {
        if !target.syncFolderPath.isEmpty {
            return "vault/\(target.syncFolderPath)"
        } else if isMulti {
            return "vault/\(target.handle)"
        } else {
            return "vault root"
        }
    }

    /// Map a per-target `TargetSyncState` to a card display state.
    private func stateFromPerTarget(_ perTarget: TargetSyncState, conflictCount: Int) -> SyncTarget.State {
        if conflictCount > 0 { return .conflict }
        guard let raw = perTarget.lastSyncStatus else { return .idle }
        switch raw {
        case "ok":       return .idle
        case "partial":  return .idle   // partial = some succeeded; show idle not error
        case "error":    return .error
        case "conflict": return .conflict
        default:         return .idle
        }
    }

    /// Per `StatusStore` semantics: read the global status string. We only
    /// hit this branch in the single-target case where the global state is
    /// the target's state.
    private func stateFromGlobal(_ state: DaemonState?, conflictCount: Int) -> SyncTarget.State {
        if conflictCount > 0 { return .conflict }
        guard let raw = state?.lastSyncStatus else { return .idle }
        switch raw {
        case "ok":       return .idle
        case "error":    return .error
        case "conflict": return .conflict
        case "never":    return .idle
        default:         return .idle
        }
    }

    private func relativeString(from date: Date?) -> String? {
        guard let date = date else { return nil }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}

struct DashboardView: View {
    @ObservedObject var controller: DashboardController
    @ObservedObject var preview: PreviewController
    @ObservedObject var license: LicenseController
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        HStack(spacing: 0) {
            SidebarNav(
                selected: $controller.section,
                isFreeTier: license.isFree
            )
            DashboardMain(controller: controller, license: license) { handle in
                preview.configure(targetHandle: handle)
                NSApplication.shared.setActivationPolicy(.regular)
                NSApplication.shared.activate(ignoringOtherApps: true)
                openWindow(id: "preview")
            }
        }
        .frame(minWidth: 960, minHeight: 640)
        .background(DS.Surface.base)
        .preferredColorScheme(.dark)
        .onAppear { controller.start(); license.refresh() }
        .onDisappear { controller.stop() }
    }
}

// MARK: - Sidebar

private struct SidebarNav: View {
    @Binding var selected: DashboardController.Section
    var isFreeTier: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // App title
            HStack(spacing: 8) {
                Image(systemName: "circle.hexagongrid.fill")
                    .foregroundStyle(DS.Accent.onDark)
                Text("Specter")
                    .font(DS.Typography.headlineSm())
                    .foregroundStyle(DS.Text.primary)
            }
            .padding(.horizontal, 20)
            .padding(.top, 20)
            .padding(.bottom, 24)

            // Section nav
            VStack(alignment: .leading, spacing: 2) {
                ForEach(DashboardController.Section.allCases) { section in
                    SidebarRow(
                        section: section,
                        isActive: selected == section
                    ) {
                        selected = section
                    }
                }
            }
            .padding(.horizontal, 12)

            Spacer()

            // Pro badge / upsell
            HStack {
                if isFreeTier {
                    DSPill(text: "FREE", tone: .neutral)
                    Spacer()
                    Button("Upgrade") {}
                        .buttonStyle(DSPrimaryButtonStyle())
                } else {
                    DSPill(text: "● PRO", tone: .success)
                    Spacer()
                }
            }
            .padding(20)
        }
        .frame(width: DS.Space.sidebarW)
        .frame(maxHeight: .infinity)
        .background(DS.Surface.panel)
        .overlay(
            Rectangle()
                .fill(DS.Surface.borderSubtle)
                .frame(width: 1),
            alignment: .trailing
        )
    }
}

private struct SidebarRow: View {
    let section: DashboardController.Section
    let isActive: Bool
    let action: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                // 2px active bar on the left
                Rectangle()
                    .fill(isActive ? DS.Accent.primary : Color.clear)
                    .frame(width: 2, height: 16)

                Image(systemName: section.icon)
                    .font(.system(size: 13))
                    .foregroundStyle(isActive ? DS.Accent.onDark : DS.Text.muted)
                    .frame(width: 16)

                Text(section.label)
                    .font(DS.Typography.bodyMd())
                    .foregroundStyle(isActive ? DS.Text.primary : DS.Text.muted)

                Spacer()
            }
            .padding(.vertical, 8)
            .padding(.trailing, 12)
            .background(rowBg)
            .clipShape(RoundedRectangle(cornerRadius: DS.Radius.base))
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
    }

    private var rowBg: Color {
        if isActive { return DS.Accent.soft }
        if isHovered { return DS.Surface.hover }
        return .clear
    }
}

// MARK: - Main content

private struct DashboardMain: View {
    @ObservedObject var controller: DashboardController
    @ObservedObject var license: LicenseController
    var onPreviewTarget: (String) -> Void

    var body: some View {
        Group {
            switch controller.section {
            case .targets:   TargetsPane(controller: controller, onPreviewTarget: onPreviewTarget)
            case .activity:  ActivityPane(controller: controller)
            case .conflicts: ConflictsPane(controller: controller)
            case .settings:  SettingsPane(controller: controller, license: license)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct TargetsPane: View {
    @ObservedObject var controller: DashboardController
    var onPreviewTarget: (String) -> Void
    @Environment(\.openWindow) private var openWindow

    /// Persisted grid/list preference (mockup's view toggle).
    @AppStorage("connectionsLayout") private var layout: String = "grid"

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DS.Space.section) {
                // Top bar
                HStack(spacing: 12) {
                    Text("Connections")
                        .font(DS.Typography.headlineMd())
                        .foregroundStyle(DS.Text.primary)
                    Spacer()
                    Picker("", selection: $layout) {
                        Image(systemName: "square.grid.2x2").tag("grid")
                        Image(systemName: "list.bullet").tag("list")
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .fixedSize()
                    Menu("+ Add connection") {
                        Button("Ghost…") {
                            // First run (no config yet) still goes through
                            // onboarding so the user picks a vault folder; once
                            // a base config exists, add Nth Ghost blogs via the
                            // dedicated connect form (which appends a new target
                            // rather than overwriting the single-Ghost slot).
                            controller.ghostConnect?.reset()
                            NSApplication.shared.setActivationPolicy(.regular)
                            NSApplication.shared.activate(ignoringOtherApps: true)
                            openWindow(id: ConfigStore.exists ? "ghost-connect" : "onboarding")
                        }
                        Button("Shopify…") {
                            if let url = URL(string: "https://spectersync.com/connect-shopify") {
                                NSWorkspace.shared.open(url)
                            }
                        }
                        Button("WordPress…") {
                            NSApplication.shared.setActivationPolicy(.regular)
                            NSApplication.shared.activate(ignoringOtherApps: true)
                            openWindow(id: "wordpress-connect")
                        }
                        Button("Webflow…") {
                            controller.webflowConnect?.reset()
                            NSApplication.shared.setActivationPolicy(.regular)
                            NSApplication.shared.activate(ignoringOtherApps: true)
                            openWindow(id: "webflow-connect")
                        }
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                }

                Rectangle()
                    .fill(DS.Surface.borderSubtle)
                    .frame(height: 1)

                if controller.targets.isEmpty {
                    EmptyTargetsState()
                } else if layout == "list" {
                    VStack(spacing: DS.Space.unit * 2) {
                        ForEach($controller.targets) { $target in
                            SyncCardRow(target: $target,
                                        onPull: pull($target.wrappedValue.id),
                                        onPush: push($target.wrappedValue.id),
                                        onDryRun: { onPreviewTarget($target.wrappedValue.id) },
                                        onEdit: edit($target.wrappedValue.id),
                                        onTest: { controller.testTarget(handle: $target.wrappedValue.id) },
                                        onRemove: { controller.removeTarget(handle: $target.wrappedValue.id) },
                                        onResolveConflict: {},
                                        onAutoSyncChange: auto($target.wrappedValue.id))
                        }
                    }
                } else {
                    LazyVGrid(
                        columns: [GridItem(.flexible(), spacing: DS.Space.gutter),
                                  GridItem(.flexible(), spacing: DS.Space.gutter)],
                        spacing: DS.Space.gutter
                    ) {
                        ForEach($controller.targets) { $target in
                            SyncCard(target: $target,
                                     onPull: pull($target.wrappedValue.id),
                                     onPush: push($target.wrappedValue.id),
                                     onDryRun: { onPreviewTarget($target.wrappedValue.id) },
                                     onEdit: edit($target.wrappedValue.id),
                                     onTest: { controller.testTarget(handle: $target.wrappedValue.id) },
                                     onRemove: { controller.removeTarget(handle: $target.wrappedValue.id) },
                                     onResolveConflict: {},
                                     onAutoSyncChange: auto($target.wrappedValue.id))
                        }
                    }
                }
            }
            .padding(DS.Space.section)
            .frame(maxWidth: DS.Space.containerMax, alignment: .topLeading)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
    }

    // Closure factories shared by the grid card and list row so the wiring
    // isn't duplicated per layout branch.
    private func pull(_ id: String) -> () -> Void { { controller.runAction(.pull, handle: id) } }
    private func push(_ id: String) -> () -> Void { { controller.runAction(.push, handle: id) } }
    private func auto(_ id: String) -> (Bool) -> Void {
        { enabled in controller.setAutoSync(handle: id, enabled: enabled) }
    }
    private func edit(_ id: String) -> () -> Void {
        {
            if let windowId = controller.prepareEdit(handle: id) {
                NSApplication.shared.setActivationPolicy(.regular)
                NSApplication.shared.activate(ignoringOtherApps: true)
                openWindow(id: windowId)
            }
        }
    }
}

/// Shown when `config.targets[]` is empty (clean install before onboarding).
/// Polaris-style: single elevated card, headline + body, no CTAs — onboarding
/// still kicks off via the menu-bar "Setup Specter" item so we don't fork
/// the entry path.
private struct EmptyTargetsState: View {
    var body: some View {
        VStack(alignment: .leading, spacing: DS.Space.unit * 2) {
            Text("No connected sites yet")
                .font(DS.Typography.headlineSm())
                .foregroundStyle(DS.Text.primary)
            Text("Use “+ Add connection” above to set up your first sync.")
                .font(DS.Typography.bodyMd())
                .foregroundStyle(DS.Text.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard(padding: DS.Space.gutter * 2)
    }
}

/// Sync Logs — the mockup's event table. One row per connection's last sync
/// (the rolling event feed is a deferred follow-up; see the spec). Platform
/// filter chips + a search box narrow the rows client-side.
private struct ActivityPane: View {
    @ObservedObject var controller: DashboardController

    @State private var platformFilter: String = "all"
    @State private var search: String = ""

    private var rows: [(target: SyncTarget, state: TargetSyncState?)] {
        controller.targets
            .map { ($0, controller.state?.targets?[$0.id]) }
            .filter { platformFilter == "all" || $0.0.platform.displayName == platformFilter }
            .filter { row in
                guard !search.isEmpty else { return true }
                let hay = "\(row.0.platform.displayName) \(row.0.label) \(SyncLogRow.description(for: row.1))".lowercased()
                return hay.contains(search.lowercased())
            }
    }

    private var platforms: [String] {
        var seen: [String] = []
        for t in controller.targets where !seen.contains(t.platform.displayName) {
            seen.append(t.platform.displayName)
        }
        return seen
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DS.Space.section) {
                HStack(alignment: .firstTextBaseline) {
                    Text("Sync Logs")
                        .font(DS.Typography.headlineMd())
                        .foregroundStyle(DS.Text.primary)
                    Spacer()
                    if !controller.targets.isEmpty {
                        TextField("Search…", text: $search)
                            .textFieldStyle(.plain)
                            .padding(.horizontal, 10).padding(.vertical, 5)
                            .background(DS.Surface.input, in: RoundedRectangle(cornerRadius: DS.Radius.base))
                            .overlay(RoundedRectangle(cornerRadius: DS.Radius.base)
                                .strokeBorder(DS.Surface.borderSubtle, lineWidth: 1))
                            .frame(width: 220)
                    }
                }

                if controller.targets.isEmpty {
                    Text("No sync has run yet. Connect a platform and sync to see events here.")
                        .font(DS.Typography.bodyMd())
                        .foregroundStyle(DS.Text.muted)
                        .dsCard(padding: DS.Space.gutter * 2)
                } else {
                    // Filter chips
                    HStack(spacing: DS.Space.unit * 2) {
                        FilterChip(label: "All", active: platformFilter == "all") { platformFilter = "all" }
                        ForEach(platforms, id: \.self) { p in
                            FilterChip(label: p, active: platformFilter == p) { platformFilter = p }
                        }
                    }

                    // Table
                    VStack(spacing: 0) {
                        SyncLogHeader()
                        ForEach(rows, id: \.target.id) { row in
                            SyncLogRow(target: row.target, state: row.state)
                            Rectangle().fill(DS.Surface.borderSubtle).frame(height: 1)
                        }
                    }
                    .dsCard(padding: 0)
                }
            }
            .padding(DS.Space.section)
            .frame(maxWidth: DS.Space.containerMax, alignment: .topLeading)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
    }
}

private struct FilterChip: View {
    let label: String
    let active: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label.uppercased())
                .font(DS.Typography.labelSm())
                .foregroundStyle(active ? DS.Text.onPrimary : DS.Text.muted)
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(active ? DS.Accent.primary : DS.Surface.elevated,
                            in: RoundedRectangle(cornerRadius: DS.Radius.base))
                .overlay(RoundedRectangle(cornerRadius: DS.Radius.base)
                    .strokeBorder(active ? Color.clear : DS.Surface.borderSubtle, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

private struct SyncLogHeader: View {
    var body: some View {
        HStack(spacing: DS.Space.gutter) {
            cell("PLATFORM", width: 160, align: .leading)
            cell("STATUS", width: 110, align: .leading)
            cell("DESCRIPTION", width: nil, align: .leading)
            cell("TIMESTAMP", width: 160, align: .trailing)
        }
        .padding(.horizontal, DS.Space.gutter)
        .padding(.vertical, DS.Space.gutter)
        .background(DS.Surface.panel)
        .overlay(Rectangle().fill(DS.Surface.borderSubtle).frame(height: 1), alignment: .bottom)
    }

    @ViewBuilder
    private func cell(_ text: String, width: CGFloat?, align: Alignment) -> some View {
        Text(text)
            .font(DS.Typography.labelSm())
            .foregroundStyle(DS.Text.outline)
            .frame(width: width, alignment: align)
            .frame(maxWidth: width == nil ? .infinity : nil, alignment: align)
    }
}

private struct SyncLogRow: View {
    let target: SyncTarget
    let state: TargetSyncState?

    var body: some View {
        HStack(spacing: DS.Space.gutter) {
            HStack(spacing: 8) {
                PlatformIconTile(systemName: target.platformIcon, size: 28)
                Text(target.platform.displayName)
                    .font(DS.Typography.bodyMd())
                    .foregroundStyle(DS.Text.primary)
                    .lineLimit(1)
            }
            .frame(width: 160, alignment: .leading)

            DSPill(text: statusText, tone: statusTone, dot: true)
                .frame(width: 110, alignment: .leading)

            Text(Self.description(for: state))
                .font(DS.Typography.bodyMd())
                .foregroundStyle(DS.Text.muted)
                .frame(maxWidth: .infinity, alignment: .leading)
                .lineLimit(2)

            Text(Self.timestamp(state?.lastSyncAt))
                .font(DS.Typography.bodySm())
                .foregroundStyle(DS.Text.outline)
                .frame(width: 160, alignment: .trailing)
        }
        .padding(.horizontal, DS.Space.gutter)
        .padding(.vertical, DS.Space.gutter)
    }

    private var statusText: String { (state?.lastSyncStatus ?? "never").uppercased() }
    private var statusTone: DSPill.Tone {
        switch state?.lastSyncStatus {
        case "ok":              return .success
        case "error":           return .error
        case "partial":         return .warning
        default:                return .neutral
        }
    }

    static func description(for state: TargetSyncState?) -> String {
        guard let s = state else { return "No sync has run yet." }
        if let err = s.lastError, !err.isEmpty { return err }
        var parts = ["Pulled \(s.lastPullCount ?? 0)", "pushed \(s.lastPushCount ?? 0)"]
        if (s.lastConflicts ?? 0) > 0 { parts.append("\(s.lastConflicts!) conflict(s)") }
        return parts.joined(separator: ", ") + "."
    }

    static func timestamp(_ iso: String?) -> String {
        guard let iso, let date = ISO8601DateFormatter().date(from: iso) else { return "—" }
        let f = DateFormatter()
        f.dateFormat = "MMM d, yyyy — HH:mm:ss"
        return f.string(from: date)
    }
}

private struct ConflictsPane: View {
    @ObservedObject var controller: DashboardController

    private var conflicts: [QueuedConflict] {
        controller.state?.conflicts ?? []
    }

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Space.section) {
            Text("Conflicts")
                .font(DS.Typography.headlineMd())
                .foregroundStyle(DS.Text.primary)

            if conflicts.isEmpty {
                VStack(alignment: .leading, spacing: DS.Space.unit) {
                    Text("No queued conflicts")
                        .font(DS.Typography.headlineSm())
                        .foregroundStyle(DS.Text.primary)
                    Text("Sync errors are shown in Activity. Conflicts only appear here when the same post changed locally and remotely.")
                        .font(DS.Typography.bodyMd())
                        .foregroundStyle(DS.Text.muted)
                }
                .dsCard(padding: DS.Space.gutter * 2)
            } else {
                ForEach(conflicts) { conflict in
                    VStack(alignment: .leading, spacing: DS.Space.unit) {
                        Text(conflict.displayTitle)
                            .font(DS.Typography.headlineSm())
                            .foregroundStyle(DS.Text.primary)
                        Text(conflict.displayMessage)
                            .font(DS.Typography.bodySm())
                            .foregroundStyle(DS.Text.muted)
                        Text(conflict.localPost.file.path)
                            .font(DS.Typography.bodySm())
                            .foregroundStyle(DS.Text.muted)
                            .textSelection(.enabled)
                    }
                    .dsCard(padding: DS.Space.gutter)
                }
            }
        }
        .padding(DS.Space.section)
        .frame(maxWidth: DS.Space.containerMax, alignment: .topLeading)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

/// Settings pane — the single home for preferences (folded in from the retired
/// standalone Settings window). Holds GLOBAL app prefs only: vault folder,
/// launch-at-login, license, and the OAuth broker override. Per-connection
/// settings (sync mode, conflict strategy, content kinds) live on each
/// connection, not here. Below the prefs: the connections list (Edit / Test /
/// Disconnect), reusing the same controller methods the cards call.
private struct SettingsPane: View {
    @ObservedObject var controller: DashboardController
    @ObservedObject var license: LicenseController
    @Environment(\.openWindow) private var openWindow

    @State private var oauthDraft: String = ""
    @State private var keyInput: String = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DS.Space.section) {
                Text("Settings")
                    .font(DS.Typography.headlineMd())
                    .foregroundStyle(DS.Text.primary)

                generalSection
                licenseSection
                advancedSection
                connectionsSection
            }
            .padding(DS.Space.section)
            .frame(maxWidth: DS.Space.containerMax, alignment: .topLeading)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .onAppear { oauthDraft = controller.oauthBaseUrl }
    }

    // MARK: General

    private var generalSection: some View {
        VStack(alignment: .leading, spacing: DS.Space.gutter) {
            sectionHeader("General", "Where Specter keeps your markdown and how it launches.")

            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Local folder").font(DS.Typography.labelMd()).foregroundStyle(DS.Text.muted)
                    Text(controller.vaultPath.isEmpty ? "No folder chosen" : controller.vaultPath)
                        .font(DS.Typography.bodySm())
                        .foregroundStyle(controller.vaultPath.isEmpty ? DS.Text.outline : DS.Text.primary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                }
                Spacer()
                Button("Choose Folder…") { controller.pickVaultFolder() }
                    .buttonStyle(DSGhostButtonStyle())
            }

            Toggle(isOn: Binding(
                get: { LoginItem.isEnabled },
                set: { _ in LoginItem.toggle() }
            )) {
                Text("Launch at login").font(DS.Typography.bodyMd()).foregroundStyle(DS.Text.primary)
            }
            .toggleStyle(.switch)

            HStack(spacing: DS.Space.unit * 2) {
                Button("Open Sync Folder") { controller.openSyncFolder() }
                    .buttonStyle(DSGhostButtonStyle())
                    .disabled(controller.vaultPath.isEmpty)
                Button("View Logs") { controller.openLogs() }
                    .buttonStyle(DSGhostButtonStyle())
            }
        }
        .dsCard(padding: DS.Space.gutter)
    }

    // MARK: License

    @ViewBuilder
    private var licenseSection: some View {
        VStack(alignment: .leading, spacing: DS.Space.gutter) {
            sectionHeader("License", "Activation is per-Mac. Syncing requires Specter Pro.")
            switch license.state {
            case .loading:
                HStack { ProgressView().controlSize(.small); Text("Loading license…").foregroundStyle(DS.Text.muted) }
            case .failed(let msg):
                Text(msg).font(DS.Typography.bodySm()).foregroundStyle(DS.Status.error)
            case .loaded(let status):
                if status.tier == "pro" { proView(status) } else { freeView }
            }
        }
        .dsCard(padding: DS.Space.gutter)
    }

    private var freeView: some View {
        VStack(alignment: .leading, spacing: DS.Space.unit * 2) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Not activated").font(DS.Typography.headlineSm()).foregroundStyle(DS.Text.primary)
                    Text("Activate Specter Pro to upload changes.")
                        .font(DS.Typography.bodySm()).foregroundStyle(DS.Text.muted)
                }
                Spacer()
                Button("Subscribe — $99/year") { NSWorkspace.shared.open(MenuActions.buyProURL) }
                    .buttonStyle(DSPrimaryButtonStyle())
            }
            HStack {
                SecureField("XXXX-XXXX-XXXX-XXXX", text: $keyInput).textFieldStyle(.roundedBorder)
                Button {
                    let key = keyInput.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !key.isEmpty else { return }
                    license.activate(key: key) { ok in if ok { keyInput = "" } }
                } label: {
                    if license.isActivating { ProgressView().controlSize(.small) } else { Text("Activate") }
                }
                .buttonStyle(DSGhostButtonStyle())
                .disabled(keyInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || license.isActivating)
            }
            if let err = license.lastError {
                Text(err).font(DS.Typography.bodySm()).foregroundStyle(DS.Status.error).lineLimit(3)
            }
        }
    }

    private func proView(_ status: LicenseStatus) -> some View {
        VStack(alignment: .leading, spacing: DS.Space.unit * 2) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        DSPill(text: "● PRO", tone: .success)
                        Text(status.key ?? "—").font(DS.Typography.bodySm()).foregroundStyle(DS.Text.muted)
                    }
                    if let validated = status.lastValidatedAt {
                        Text("Last validated: \(validated)")
                            .font(DS.Typography.bodySm()).foregroundStyle(DS.Text.outline)
                    }
                }
                Spacer()
                Button("Deactivate on this Mac") { license.deactivate { _ in } }
                    .buttonStyle(DSGhostButtonStyle(tone: DS.Status.error))
            }
        }
    }

    // MARK: Advanced

    private var advancedSection: some View {
        VStack(alignment: .leading, spacing: DS.Space.gutter) {
            sectionHeader("Advanced", "Leave blank to use Specter's hosted OAuth (recommended).")
            HStack {
                TextField(OAuthController.defaultBaseURLString, text: $oauthDraft)
                    .textFieldStyle(.roundedBorder)
                Button("Save") { controller.saveOAuthBaseUrl(oauthDraft) }
                    .buttonStyle(DSGhostButtonStyle())
                    .disabled(oauthDraft.trimmingCharacters(in: .whitespacesAndNewlines) == controller.oauthBaseUrl)
            }
        }
        .dsCard(padding: DS.Space.gutter)
    }

    // MARK: Connections

    private var connectionsSection: some View {
        VStack(alignment: .leading, spacing: DS.Space.gutter) {
            sectionHeader("Connections", "Every CMS Specter syncs. Each lives in its own vault folder.")
            if controller.targets.isEmpty {
                Text("No connections yet. Add one from the Connections tab.")
                    .font(DS.Typography.bodyMd())
                    .foregroundStyle(DS.Text.muted)
            } else {
                VStack(spacing: DS.Space.unit * 1.5) {
                    ForEach(controller.targets) { target in
                        TargetSettingsRow(
                            target: target,
                            onEdit: {
                                if let windowId = controller.prepareEdit(handle: target.id) {
                                    NSApplication.shared.setActivationPolicy(.regular)
                                    NSApplication.shared.activate(ignoringOtherApps: true)
                                    openWindow(id: windowId)
                                }
                            },
                            onTest:   { controller.testTarget(handle: target.id) },
                            onRemove: { controller.removeTarget(handle: target.id) }
                        )
                    }
                }
            }
        }
        .dsCard(padding: DS.Space.gutter)
    }

    private func sectionHeader(_ title: String, _ subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: DS.Space.unit) {
            Text(title).font(DS.Typography.headlineSm()).foregroundStyle(DS.Text.primary)
            Text(subtitle).font(DS.Typography.bodySm()).foregroundStyle(DS.Text.muted)
        }
    }
}

private struct TargetSettingsRow: View {
    let target: SyncTarget
    var onEdit: () -> Void
    var onTest: () -> Void
    var onRemove: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: DS.Space.gutter) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(displayLabel)
                        .font(DS.Typography.headlineSm())
                        .foregroundStyle(DS.Text.primary)
                    DSPill(text: target.platform.displayName, tone: .neutral)
                }
                Text(target.id)
                    .font(DS.Typography.bodySm())
                    .foregroundStyle(DS.Text.muted)
                    .textSelection(.enabled)
                Text(target.siteUrl)
                    .font(DS.Typography.bodySm())
                    .foregroundStyle(DS.Text.outline)
                Text(target.summary)
                    .font(DS.Typography.bodySm())
                    .foregroundStyle(DS.Text.outline)
                Text(ContentKinds.summary(target.contentKinds))
                    .font(DS.Typography.bodySm())
                    .foregroundStyle(target.contentKinds.isEmpty ? DS.Status.warning : DS.Text.outline)
            }
            Spacer()
            HStack(spacing: 8) {
                Button("Edit", action: onEdit).buttonStyle(DSGhostButtonStyle())
                Button("Test", action: onTest).buttonStyle(DSGhostButtonStyle())
                Button("Disconnect", action: onRemove)
                    .buttonStyle(DSGhostButtonStyle(tone: DS.Status.error))
            }
        }
        .dsCard(padding: DS.Space.gutter)
    }

    private var displayLabel: String {
        target.label.isEmpty ? target.platform.displayName : target.label
    }
}

private struct PlaceholderPane: View {
    let title: String
    let message: String

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Space.gutter) {
            Text(title)
                .font(DS.Typography.headlineMd())
                .foregroundStyle(DS.Text.primary)
            Text(message)
                .font(DS.Typography.bodyMd())
                .foregroundStyle(DS.Text.muted)
        }
        .padding(DS.Space.section)
    }
}

#if DEBUG
#Preview {
    DashboardView(controller: DashboardController(), preview: PreviewController(), license: LicenseController())
        .frame(width: 1100, height: 720)
}
#endif
