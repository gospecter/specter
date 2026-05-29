import AppKit
import Foundation
import ServiceManagement
import SwiftUI

// MARK: - Daemon state (shape matches src/config.ts)

struct DaemonState: Decodable {
    var lastSyncAt: String?
    var lastSyncStatus: String?
    var lastSyncMessage: String?
    var lastPulled: Int?
    var lastPushed: Int?
    var lastConflicts: Int?
    var lastErrors: Int?
    var binaryPath: String?
    var nodePath: String?
    var conflicts: [QueuedConflict]?
    /// Per-target last-sync metrics keyed by handle (v0.5.1+). Optional so
    /// pre-v0.5.1 state.json files still decode. Dashboard cards read here
    /// without recomputing from global counters.
    var targets: [String: TargetSyncState]?
}

/// Mirror of the daemon's TargetSyncState (src/config.ts). Hand-written so the
/// shipped Mac app can keep round-tripping without depending on the generated
/// Swift artifacts under schemas/swift/.
struct TargetSyncState: Decodable {
    var lastSyncAt: String?
    var lastSyncStatus: String?
    var lastPullCount: Int?
    var lastPushCount: Int?
    var lastConflicts: Int?
    var lastError: String?
}

struct QueuedConflict: Decodable, Identifiable {
    var id: String
    var createdAt: String
    var type: String
    var localPost: QueuedLocalPost
    var ghostPost: QueuedGhostPost?
}

struct QueuedLocalPost: Decodable {
    var title: String
    var file: QueuedVaultFile
}

struct QueuedVaultFile: Decodable {
    var path: String
    var basename: String
}

struct QueuedGhostPost: Decodable {
    var title: String?
}

enum SyncStatus: String {
    case ok, error, conflict, never, syncing, unknown

    var tint: Color {
        switch self {
        case .ok: return .primary
        case .error: return .red
        case .conflict: return .orange
        case .syncing: return .blue
        case .never, .unknown: return .secondary
        }
    }

    var symbolName: String {
        switch self {
        case .ok: return "checkmark.icloud"
        case .error: return "exclamationmark.icloud"
        case .conflict: return "questionmark.circle"
        case .syncing: return "arrow.triangle.2.circlepath.icloud"
        case .never, .unknown: return "icloud"
        }
    }
}

struct GhostStatusIcon: View {
    let status: SyncStatus

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            GhostGlyph()
                .fill(status.tint)
                .frame(width: 18, height: 18)
            if status == .syncing {
                Image(systemName: "arrow.triangle.2.circlepath")
                    .font(.system(size: 7, weight: .bold))
                    .foregroundStyle(.blue)
                    .offset(x: 4, y: 3)
            } else if status == .error {
                Image(systemName: "exclamationmark.circle.fill")
                    .font(.system(size: 7, weight: .bold))
                    .foregroundStyle(.red)
                    .offset(x: 4, y: 3)
            } else if status == .conflict {
                Image(systemName: "questionmark.circle.fill")
                    .font(.system(size: 7, weight: .bold))
                    .foregroundStyle(.orange)
                    .offset(x: 4, y: 3)
            }
        }
        .frame(width: 22, height: 22)
    }
}

struct GhostGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let w = rect.width
        let h = rect.height

        path.move(to: CGPoint(x: 0.12 * w, y: 0.88 * h))
        path.addLine(to: CGPoint(x: 0.12 * w, y: 0.48 * h))
        path.addCurve(
            to: CGPoint(x: 0.88 * w, y: 0.48 * h),
            control1: CGPoint(x: 0.12 * w, y: 0.06 * h),
            control2: CGPoint(x: 0.88 * w, y: 0.06 * h)
        )
        path.addLine(to: CGPoint(x: 0.88 * w, y: 0.88 * h))
        path.addCurve(
            to: CGPoint(x: 0.76 * w, y: 0.96 * h),
            control1: CGPoint(x: 0.88 * w, y: 0.98 * h),
            control2: CGPoint(x: 0.82 * w, y: 1.0 * h)
        )
        path.addCurve(
            to: CGPoint(x: 0.62 * w, y: 0.88 * h),
            control1: CGPoint(x: 0.70 * w, y: 0.90 * h),
            control2: CGPoint(x: 0.68 * w, y: 0.86 * h)
        )
        path.addCurve(
            to: CGPoint(x: 0.50 * w, y: 0.96 * h),
            control1: CGPoint(x: 0.56 * w, y: 0.90 * h),
            control2: CGPoint(x: 0.56 * w, y: 0.96 * h)
        )
        path.addCurve(
            to: CGPoint(x: 0.38 * w, y: 0.88 * h),
            control1: CGPoint(x: 0.44 * w, y: 0.96 * h),
            control2: CGPoint(x: 0.44 * w, y: 0.90 * h)
        )
        path.addCurve(
            to: CGPoint(x: 0.24 * w, y: 0.96 * h),
            control1: CGPoint(x: 0.32 * w, y: 0.86 * h),
            control2: CGPoint(x: 0.30 * w, y: 0.90 * h)
        )
        path.addCurve(
            to: CGPoint(x: 0.12 * w, y: 0.88 * h),
            control1: CGPoint(x: 0.18 * w, y: 1.0 * h),
            control2: CGPoint(x: 0.12 * w, y: 0.98 * h)
        )
        path.closeSubpath()

        return path
    }
}

// MARK: - Status store

@MainActor
final class StatusStore: ObservableObject {
    @Published var state: DaemonState = DaemonState()
    @Published var status: SyncStatus = .unknown
    @Published var isManualRunning: Bool = false
    @Published var activeConflict: QueuedConflict?

    private var timer: Timer?

    func start() {
        reload()
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.reload() }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    func reload() {
        if let data = try? Data(contentsOf: Paths.statePath),
           let decoded = try? JSONDecoder().decode(DaemonState.self, from: data) {
            self.state = decoded
            self.activeConflict = decoded.conflicts?.first
            if !isManualRunning {
                self.status = SyncStatus(rawValue: decoded.lastSyncStatus ?? "never") ?? .unknown
            }
        } else {
            self.state = DaemonState()
            self.activeConflict = nil
            if !isManualRunning { self.status = .never }
        }
    }

    var lastSyncRelative: String {
        guard let iso = state.lastSyncAt,
              let date = ISO8601DateFormatter().date(from: iso) else { return "never" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}

extension QueuedConflict {
    var displayTitle: String {
        if !localPost.title.isEmpty { return localPost.title }
        return localPost.file.basename
    }

    var displayMessage: String {
        switch type {
        case "deleted_remotely":
            return "This local post was deleted in Ghost. Choose which version should win."
        case "deleted_locally":
            return "This post was deleted locally. Choose which version should win."
        default:
            return "Both the local and Ghost versions changed since the last sync. Choose which version should win."
        }
    }
}

// MARK: - One-shot CLI runner for menu actions

enum MenuActions {
    /// Run a one-shot ghost-sync subcommand and notify on every completion.
    /// Silent success is the worst UX — without a notification the user
    /// can't tell if the click did anything.
    static func run(_ subcommand: String, store: StatusStore) {
        runForTarget(subcommand, targetHandle: nil, store: store, dryRun: false, onComplete: nil)
    }

    /// Variant used by the Dashboard's per-card buttons. Spawns the same
    /// short-lived `node daemon.mjs <subcommand>` process but appends
    /// `--target <handle>` so the daemon scopes the run to a single
    /// configured target. `onComplete` fires on the main thread after the
    /// process exits (succeeded == true on status 0) so callers can refresh
    /// UI without waiting for the 5-second poll.
    ///
    /// Contract with the daemon (Stream A adds the flag in parallel):
    ///   node daemon.mjs pull --target <handle>
    ///   node daemon.mjs push --target <handle>
    ///   node daemon.mjs sync --target <handle>
    ///   node daemon.mjs sync --target <handle> --dry-run
    /// Invalid `<handle>` exits non-zero; stderr is surfaced to the alert.
    static func runForTarget(
        _ subcommand: String,
        targetHandle: String?,
        store: StatusStore,
        dryRun: Bool = false,
        onComplete: ((Bool) -> Void)? = nil
    ) {
        NSLog("[Specter] MenuActions.runForTarget subcommand=%@ target=%@ dryRun=%@",
              subcommand, targetHandle ?? "nil", dryRun ? "true" : "false")
        guard let node = Paths.nodeBinary(), let entry = Paths.daemonEntry() else {
            NSLog("[Specter] MenuActions.runForTarget BAIL — nodeBinary=%@ daemonEntry=%@",
                  Paths.nodeBinary()?.path ?? "nil",
                  Paths.daemonEntry()?.path ?? "nil")
            DispatchQueue.main.async {
                showAlert("Specter not installed correctly",
                          "Couldn't find the bundled daemon. Reinstall the app.")
                onComplete?(false)
            }
            return
        }
        Task { @MainActor in
            store.isManualRunning = true
            store.status = .syncing
        }

        // Build user-facing label for the running/finished notifications.
        // Dry-run + handle both appear in the message so the notification
        // makes sense when the user fired several targets at once.
        let label = displayLabel(subcommand, target: targetHandle, dryRun: dryRun)
        notify("Specter", "Running \(label)…")

        // Assemble argv. Order is `<subcommand> [--target <h>] [--dry-run]`,
        // matching the CLI's commander-style flags-after-positional.
        var argv: [String] = [entry.path, subcommand]
        if let handle = targetHandle, !handle.isEmpty {
            argv.append("--target")
            argv.append(handle)
        }
        if dryRun {
            argv.append("--dry-run")
        }

        DispatchQueue.global().async {
            let task = Process()
            task.executableURL = node
            task.arguments = argv
            // Minimal env only — never inherit the full shell env (see
            // .ai/CONVENTIONS.md "Security Rules" + "Do Not"). The daemon needs
            // PATH (to locate any child tooling) and HOME (config + state live there).
            let parentEnv = ProcessInfo.processInfo.environment
            var env: [String: String] = [
                "PATH": "/opt/homebrew/bin:/usr/local/bin:" + (parentEnv["PATH"] ?? "/usr/bin:/bin")
            ]
            if let home = parentEnv["HOME"] { env["HOME"] = home }
            task.environment = env
            let err = Pipe()
            task.standardError = err
            task.standardOutput = Pipe()

            var succeeded = false
            var errMessage = ""
            do {
                try task.run()
                task.waitUntilExit()
                if task.terminationStatus == 0 {
                    succeeded = true
                } else {
                    let data = err.fileHandleForReading.readDataToEndOfFile()
                    errMessage = String(data: data, encoding: .utf8)?
                        .trimmingCharacters(in: .whitespacesAndNewlines) ?? "Unknown error"
                }
            } catch {
                errMessage = error.localizedDescription
            }

            DispatchQueue.main.async {
                store.isManualRunning = false
                store.reload()
                if succeeded {
                    let msg = store.state.lastSyncMessage ?? "Done"
                    notify("Specter", "\(label): \(msg)")
                } else if isLicenseLimitError(errMessage) {
                    notify("Specter — Free limit reached",
                           "You've used all 200 free uploads this month.")
                    showLicenseLimitAlert()
                } else {
                    notify("Specter failed", errMessage)
                    showAlert("\(label) failed", errMessage)
                }
                onComplete?(succeeded)
            }
        }
    }

    /// Build "sync (dry-run) [blog]" style labels for notifications + alerts.
    private static func displayLabel(_ subcommand: String, target: String?, dryRun: Bool) -> String {
        var s = subcommand
        if dryRun { s += " (dry-run)" }
        if let t = target, !t.isEmpty { s += " [\(t)]" }
        return s
    }

    static func resolve(_ conflict: QueuedConflict, keep: String, store: StatusStore) {
        guard let node = Paths.nodeBinary(), let entry = Paths.daemonEntry() else {
            showAlert("Specter not installed correctly",
                      "Couldn't find the bundled daemon. Reinstall the app.")
            return
        }

        DispatchQueue.global().async {
            let task = Process()
            task.executableURL = node
            task.arguments = [entry.path, "resolve", "--id", conflict.id, "--keep", keep]
            // Minimal env only — never inherit the full shell env (see
            // .ai/CONVENTIONS.md "Security Rules"). PATH + HOME are all the daemon needs.
            let parentEnv = ProcessInfo.processInfo.environment
            var env: [String: String] = [
                "PATH": "/opt/homebrew/bin:/usr/local/bin:" + (parentEnv["PATH"] ?? "/usr/bin:/bin")
            ]
            if let home = parentEnv["HOME"] { env["HOME"] = home }
            task.environment = env
            let err = Pipe()
            task.standardError = err
            task.standardOutput = Pipe()

            var succeeded = false
            var errMessage = ""
            do {
                try task.run()
                task.waitUntilExit()
                if task.terminationStatus == 0 {
                    succeeded = true
                } else {
                    let data = err.fileHandleForReading.readDataToEndOfFile()
                    errMessage = String(data: data, encoding: .utf8)?
                        .trimmingCharacters(in: .whitespacesAndNewlines) ?? "Unknown error"
                }
            } catch {
                errMessage = error.localizedDescription
            }

            DispatchQueue.main.async {
                store.reload()
                if succeeded {
                    notify("Specter", "Resolved conflict: \(conflict.displayTitle)")
                } else {
                    notify("Specter failed", errMessage)
                    showAlert("Resolve conflict failed", errMessage)
                }
            }
        }
    }

    static func showAlert(_ title: String, _ message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    /// Specter Pro checkout — the marketing site, where Paddle.js opens the
    /// overlay checkout.
    static let buyProURL = URL(string: "https://spectersync.com/#buy")!

    /// Whether a daemon stderr dump is a free-tier upload-limit error.
    static func isLicenseLimitError(_ raw: String) -> Bool {
        raw.contains("Free tier upload limit reached")
    }

    /// A simple upgrade prompt shown when a free-tier user hits the monthly
    /// upload cap. Fixed copy + one upgrade action — no daemon text echoed.
    static func showLicenseLimitAlert() {
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = "You've reached your free limit"
        alert.informativeText =
            "Free includes 200 uploads per month, across all connected sites. "
            + "Upgrade to Specter Pro for unlimited uploads — a one-time $49 purchase."
        alert.addButton(withTitle: "Upgrade to Specter Pro")
        alert.addButton(withTitle: "Not Now")
        if alert.runModal() == .alertFirstButtonReturn {
            NSWorkspace.shared.open(buyProURL)
        }
    }

    /// Best-effort macOS notification via osascript — works without
    /// requesting UserNotifications entitlement.
    static func notify(_ title: String, _ message: String) {
        // Escape backslash BEFORE quote, or an injected `\"` round-trips back into
        // a live quote and breaks out of the AppleScript string literal.
        let t = title.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        let m = message.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        let script = "display notification \"\(m)\" with title \"\(t)\""
        DispatchQueue.global().async {
            let task = Process()
            task.launchPath = "/usr/bin/osascript"
            task.arguments = ["-e", script]
            try? task.run()
        }
    }
}

// MARK: - Menu

struct MenuView: View {
    @ObservedObject var store: StatusStore
    @ObservedObject var supervisor: DaemonSupervisor
    @ObservedObject var license: LicenseController
    @ObservedObject var updater: UpdaterController
    @ObservedObject var preview: PreviewController
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text("Specter").font(.headline)
                if isManualMode {
                    Text("Manual")
                        .font(.caption2.weight(.medium))
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Color.orange.opacity(0.15))
                        .foregroundStyle(.orange)
                        .cornerRadius(3)
                }
                if license.isFree {
                    Text("Free")
                        .font(.caption2.weight(.medium))
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Color.purple.opacity(0.18))
                        .foregroundStyle(.purple)
                        .cornerRadius(3)
                }
            }
            if !supervisor.isRunning {
                Label("Daemon stopped", systemImage: "pause.circle")
                    .font(.caption)
                    .foregroundStyle(.orange)
            } else if let msg = store.state.lastSyncMessage {
                Text(msg).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            } else {
                Text(isManualMode ? "Pulling on schedule only" : "Watching for changes…")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Text("Last sync: \(store.lastSyncRelative)")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)

        Divider()

        Button { MenuActions.run("sync", store: store) } label: {
            Label("Sync Now", systemImage: "arrow.triangle.2.circlepath")
        }
        Button { MenuActions.run("pull", store: store) } label: {
            Label("Pull from Ghost", systemImage: "icloud.and.arrow.down")
        }
        Button { MenuActions.run("push", store: store) } label: {
            Label("Push to Ghost", systemImage: "icloud.and.arrow.up")
        }
        Button {
            preview.configure(targetHandle: nil)
            NSApplication.shared.setActivationPolicy(.regular)
            NSApplication.shared.activate(ignoringOtherApps: true)
            openWindow(id: "preview")
        } label: {
            Label("Preview Sync…", systemImage: "eye")
        }

        Divider()

        Button {
            NSApplication.shared.setActivationPolicy(.regular)
            NSApplication.shared.activate(ignoringOtherApps: true)
            openWindow(id: "dashboard")
        } label: {
            Label("Open Specter…", systemImage: "square.stack.3d.up")
        }

        Button {
            // Bring the app forward so the Window is allowed to show
            // (LSUIElement apps can't show windows from background).
            NSApplication.shared.setActivationPolicy(.regular)
            NSApplication.shared.activate(ignoringOtherApps: true)
            openWindow(id: ConfigStore.exists ? "settings" : "onboarding")
        } label: {
            Label("Preferences…", systemImage: "gearshape")
        }

        Button {
            LoginItem.toggle()
        } label: {
            Label(LoginItem.isEnabled ? "Disable Launch at Login" : "Launch at Login",
                  systemImage: LoginItem.isEnabled ? "checkmark" : "power")
        }

        // Buy Pro shortcut, only when Free.
        if license.isFree, case .loaded(let status) = license.state {
            Divider()
            Button {
                NSWorkspace.shared.open(MenuActions.buyProURL)
            } label: {
                Label(
                    "Buy Specter Pro — \(status.syncCount)/\(status.freeLimit) used",
                    systemImage: "cart"
                )
            }
        }

        Divider()

        if let folder = syncFolderURL {
            Button { NSWorkspace.shared.open(folder) } label: {
                Label("Open Sync Folder", systemImage: "folder")
            }
        }
        Button { NSWorkspace.shared.open(Paths.logPath) } label: {
            Label("View Logs", systemImage: "doc.text")
        }

        Button {
            updater.checkForUpdates()
        } label: {
            Label("Check for Updates…", systemImage: "arrow.down.circle")
        }
        .disabled(!updater.canCheck)

        Divider()

        Button {
            NSApplication.shared.terminate(nil)
        } label: {
            Label("Quit Specter", systemImage: "power")
        }
        .keyboardShortcut("q")
        .alert("Resolve conflict: \(store.activeConflict?.displayTitle ?? "Untitled")",
               isPresented: Binding(
                get: { store.activeConflict != nil },
                set: { if !$0 { store.activeConflict = nil } }
               ),
               presenting: store.activeConflict) { conflict in
            Button("Keep Local") {
                MenuActions.resolve(conflict, keep: "local", store: store)
            }
            Button("Keep Ghost") {
                MenuActions.resolve(conflict, keep: "remote", store: store)
            }
            Button("Later", role: .cancel) {}
        } message: { conflict in
            Text(conflict.displayMessage)
        }
    }

    private var syncFolderURL: URL? {
        guard let cfg = ConfigStore.load(), !cfg.vaultPath.isEmpty else { return nil }
        if cfg.syncFolderPath.isEmpty {
            return URL(fileURLWithPath: cfg.vaultPath)
        }
        return URL(fileURLWithPath: cfg.vaultPath).appending(path: cfg.syncFolderPath)
    }

    private var isManualMode: Bool {
        ConfigStore.load()?.syncMode == "manual"
    }
}

// MARK: - Launch at Login

enum LoginItem {
    static var isEnabled: Bool {
        SMAppService.mainApp.status == .enabled
    }

    static func toggle() {
        do {
            if isEnabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
        } catch {
            MenuActions.showAlert("Couldn't change Login Item", error.localizedDescription)
        }
    }
}

// MARK: - App

@main
struct SpecterApp: App {
    @NSApplicationDelegateAdaptor(SpecterAppDelegate.self) private var appDelegate
    @StateObject private var store = StatusStore()
    @StateObject private var supervisor = DaemonSupervisor()
    @StateObject private var onboarding = OnboardingController()
    @StateObject private var settings = SettingsController()
    @StateObject private var preview = PreviewController()
    @StateObject private var license = LicenseController()
    @StateObject private var updater = UpdaterController()
    @StateObject private var dashboard = DashboardController()
    @StateObject private var wordpressConnect = WordPressConnectController()

    init() {
        NSApplication.shared.setActivationPolicy(.accessory)
        OAuthController.shared.register()
    }

    var body: some Scene {
        MenuBarExtra {
            MenuView(store: store, supervisor: supervisor, license: license, updater: updater, preview: preview)
        } label: {
            // Label is rendered eagerly at app launch; menu content is lazy.
            // Bootstrap here so the daemon starts before the user opens the
            // menu for the first time.
            //
            // Use an SF Symbol image, not a custom SwiftUI Shape, for the
            // label. MenuBarExtra expects a template-renderable view so the
            // system can tint it (light/dark mode, active state). A custom
            // Shape filled with a semantic color does not render reliably in
            // the menu bar — symptom is "no icon visible at all". The branded
            // ghost glyph still appears in the in-menu UI and in the .icns.
            Image(systemName: store.status.symbolName)
                .onAppear {
                    store.start()
                    // Dashboard needs both to spawn one-shot daemons + bounce
                    // the watcher when the user flips a SyncCard auto-sync
                    // toggle. Done here (not in `init`) because @StateObject
                    // wrappers aren't safe to read until the body is mounted.
                    dashboard.configure(store: store, supervisor: supervisor)
                    OAuthController.shared.warnIfProtocolOwnerMismatch()
                    license.refresh()
                    if ConfigStore.exists && !supervisor.isRunning {
                        supervisor.start()
                    }
                }
        }
        .menuBarExtraStyle(.menu)

        Window("Specter Setup", id: "onboarding") {
            OnboardingView(controller: onboarding) {
                supervisor.restart()
                store.reload()
                if let window = NSApplication.shared.windows.first(where: { $0.title == "Specter Setup" }) {
                    window.close()
                }
                NSApplication.shared.setActivationPolicy(.accessory)
            }
            .onAppear {
                onboarding.preload()
                NSApplication.shared.setActivationPolicy(.regular)
                NSApplication.shared.activate(ignoringOtherApps: true)
            }
            .onDisappear {
                NSApplication.shared.setActivationPolicy(.accessory)
            }
        }
        .windowResizability(.contentSize)
        .commandsRemoved()
        .handlesExternalEvents(matching: ["onboarding"])

        Window("Preview Sync", id: "preview") {
            PreviewSyncView(controller: preview, store: store) {
                if let window = NSApplication.shared.windows.first(where: { $0.title == "Preview Sync" }) {
                    window.close()
                }
                NSApplication.shared.setActivationPolicy(.accessory)
            }
            .onAppear {
                preview.refresh()
                NSApplication.shared.setActivationPolicy(.regular)
                NSApplication.shared.activate(ignoringOtherApps: true)
            }
            .onDisappear {
                NSApplication.shared.setActivationPolicy(.accessory)
            }
        }
        .windowResizability(.contentSize)
        .commandsRemoved()
        .handlesExternalEvents(matching: ["preview"])

        Window("Specter", id: "dashboard") {
            DashboardView(controller: dashboard, preview: preview)
                .onAppear {
                    // Belt-and-suspenders configure: also wired on the
                    // MenuBarExtra label's .onAppear, but that lifecycle is
                    // unreliable on macOS — the label can stay "unappeared"
                    // until the user clicks the menu bar icon. Without this
                    // line, opening the Dashboard from a fresh launch lands
                    // with statusStore=nil and every per-card button click
                    // silently no-ops on `guard let store = statusStore`.
                    dashboard.configure(store: store, supervisor: supervisor)
                    NSApplication.shared.setActivationPolicy(.regular)
                    NSApplication.shared.activate(ignoringOtherApps: true)
                }
                .onDisappear {
                    NSApplication.shared.setActivationPolicy(.accessory)
                }
        }
        .windowResizability(.contentMinSize)
        .commandsRemoved()
        .handlesExternalEvents(matching: ["dashboard"])

        Window("Add WordPress", id: "wordpress-connect") {
            WordPressConnectView(controller: wordpressConnect) {
                supervisor.restart()
                dashboard.reload()
                store.reload()
                wordpressConnect.reset()
                if let window = NSApplication.shared.windows.first(where: { $0.title == "Add WordPress" }) {
                    window.close()
                }
                NSApplication.shared.setActivationPolicy(.accessory)
            } onCancel: {
                wordpressConnect.reset()
                if let window = NSApplication.shared.windows.first(where: { $0.title == "Add WordPress" }) {
                    window.close()
                }
                NSApplication.shared.setActivationPolicy(.accessory)
            }
            .onAppear {
                NSApplication.shared.setActivationPolicy(.regular)
                NSApplication.shared.activate(ignoringOtherApps: true)
            }
            .onDisappear {
                NSApplication.shared.setActivationPolicy(.accessory)
            }
        }
        .windowResizability(.contentSize)
        .commandsRemoved()
        .handlesExternalEvents(matching: ["wordpress-connect"])

        Window("Specter Settings", id: "settings") {
            SettingsView(controller: settings, license: license) {
                supervisor.restart()
                store.reload()
                license.refresh()
                if let window = NSApplication.shared.windows.first(where: { $0.title == "Specter Settings" }) {
                    window.close()
                }
                NSApplication.shared.setActivationPolicy(.accessory)
            } onCancel: {
                if let window = NSApplication.shared.windows.first(where: { $0.title == "Specter Settings" }) {
                    window.close()
                }
                NSApplication.shared.setActivationPolicy(.accessory)
            }
            .onAppear {
                settings.preload()
                license.refresh()
                NSApplication.shared.setActivationPolicy(.regular)
                NSApplication.shared.activate(ignoringOtherApps: true)
            }
            .onDisappear {
                NSApplication.shared.setActivationPolicy(.accessory)
            }
        }
        .windowResizability(.contentSize)
        .commandsRemoved()
        .handlesExternalEvents(matching: ["settings"])
    }
}
