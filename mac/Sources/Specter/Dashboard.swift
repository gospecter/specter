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
            case .targets:   return "Targets"
            case .activity:  return "Activity"
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

    @Published var isFreeTier: Bool = false

    /// Set by `SpecterApp.body` once both controllers exist so the per-card
    /// actions can talk to the daemon and refresh status without each
    /// callsite re-resolving them. Optional so unit/SwiftUI previews still
    /// construct a `DashboardController()` without dependencies.
    weak var statusStore: StatusStore?
    weak var supervisor: DaemonSupervisor?

    func configure(store: StatusStore, supervisor: DaemonSupervisor) {
        self.statusStore = store
        self.supervisor = supervisor
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
                conflictCount: conflictCount
            )
        }
    }

    private func platformOf(_ adapter: AdapterConfig) -> Platform {
        switch adapter {
        case .ghost:     return .ghost
        case .shopify:   return .shopify
        case .wordpress: return .wordpress
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
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        HStack(spacing: 0) {
            SidebarNav(
                selected: $controller.section,
                isFreeTier: controller.isFreeTier
            )
            DashboardMain(controller: controller) { handle in
                preview.configure(targetHandle: handle)
                NSApplication.shared.setActivationPolicy(.regular)
                NSApplication.shared.activate(ignoringOtherApps: true)
                openWindow(id: "preview")
            }
        }
        .frame(minWidth: 960, minHeight: 640)
        .background(DS.Surface.base)
        .preferredColorScheme(.dark)
        .onAppear { controller.start() }
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
    var onPreviewTarget: (String) -> Void

    var body: some View {
        Group {
            switch controller.section {
            case .targets:   TargetsPane(controller: controller, onPreviewTarget: onPreviewTarget)
            case .activity:  ActivityPane(controller: controller)
            case .conflicts: ConflictsPane(controller: controller)
            case .settings:  PlaceholderPane(title: "Settings",
                                             message: "Targets list + defaults panel lands here (spec S6).")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct TargetsPane: View {
    @ObservedObject var controller: DashboardController
    var onPreviewTarget: (String) -> Void
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DS.Space.section) {
                // Top bar
                HStack {
                    Text("Targets")
                        .font(DS.Typography.headlineMd())
                        .foregroundStyle(DS.Text.primary)
                    Spacer()
                    Menu("+ Add target") {
                        Button("Ghost…") {
                            NSApplication.shared.setActivationPolicy(.regular)
                            NSApplication.shared.activate(ignoringOtherApps: true)
                            openWindow(id: ConfigStore.exists ? "settings" : "onboarding")
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
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                }

                Rectangle()
                    .fill(DS.Surface.borderSubtle)
                    .frame(height: 1)

                if controller.targets.isEmpty {
                    EmptyTargetsState()
                } else {
                    VStack(spacing: DS.Space.section) {
                        ForEach($controller.targets) { $target in
                            SyncCard(
                                target: $target,
                                onPull:   { controller.runAction(.pull,   handle: target.id) },
                                onPush:   { controller.runAction(.push,   handle: target.id) },
                                onDryRun: { onPreviewTarget(target.id) },
                                onMore:   { /* future: per-card menu */ },
                                onResolveConflict: { /* future: per-target conflict */ },
                                onAutoSyncChange: { enabled in
                                    controller.setAutoSync(handle: target.id,
                                                           enabled: enabled)
                                }
                            )
                        }
                    }
                }
            }
            .padding(DS.Space.section)
            .frame(maxWidth: DS.Space.containerMax, alignment: .topLeading)
            .frame(maxWidth: .infinity, alignment: .topLeading)
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
            Text("Use the menu bar to set up your first sync.")
                .font(DS.Typography.bodyMd())
                .foregroundStyle(DS.Text.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard(padding: DS.Space.gutter * 2)
    }
}

private struct ActivityPane: View {
    @ObservedObject var controller: DashboardController

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DS.Space.section) {
                VStack(alignment: .leading, spacing: DS.Space.unit) {
                    Text("Activity")
                        .font(DS.Typography.headlineMd())
                        .foregroundStyle(DS.Text.primary)
                    Text(controller.state?.lastSyncMessage ?? "No sync has run yet.")
                        .font(DS.Typography.bodyMd())
                        .foregroundStyle(DS.Text.muted)
                }

                if controller.targets.isEmpty {
                    Text("No targets connected.")
                        .font(DS.Typography.bodyMd())
                        .foregroundStyle(DS.Text.muted)
                } else {
                    VStack(spacing: DS.Space.unit * 1.5) {
                        ForEach(controller.targets) { target in
                            ActivityRow(
                                target: target,
                                state: controller.state?.targets?[target.id]
                            )
                        }
                    }
                }
            }
            .padding(DS.Space.section)
            .frame(maxWidth: DS.Space.containerMax, alignment: .topLeading)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
    }
}

private struct ActivityRow: View {
    let target: SyncTarget
    let state: TargetSyncState?

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Space.unit) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(target.platform.displayName)
                        .font(DS.Typography.headlineSm())
                        .foregroundStyle(DS.Text.primary)
                    Text(target.id)
                        .font(DS.Typography.bodySm())
                        .foregroundStyle(DS.Text.muted)
                }
                Spacer()
                DSPill(
                    text: (state?.lastSyncStatus ?? "never").uppercased(),
                    tone: state?.lastSyncStatus == "error" ? .error : .success
                )
            }

            HStack(spacing: DS.Space.gutter) {
                Text("Pulled \(state?.lastPullCount ?? 0)")
                Text("Pushed \(state?.lastPushCount ?? 0)")
                Text("Conflicts \(state?.lastConflicts ?? 0)")
            }
            .font(DS.Typography.bodySm())
            .foregroundStyle(DS.Text.muted)

            if let error = state?.lastError, !error.isEmpty {
                Text(error)
                    .font(DS.Typography.bodySm())
                    .foregroundStyle(DS.Status.error)
                    .textSelection(.enabled)
            }
        }
        .dsCard(padding: DS.Space.gutter)
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
    DashboardView(controller: DashboardController(), preview: PreviewController())
        .frame(width: 1100, height: 720)
}
#endif
