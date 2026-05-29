import AppKit
import Foundation

/// Owns the daemon child process.
///
/// On app launch (post-onboarding), starts `node daemon.mjs watch` as a child.
/// On app quit, terminates it. If the daemon dies unexpectedly, restarts it
/// with a 5-second backoff up to a small limit so a crash loop doesn't burn
/// CPU forever.
///
/// Logs are appended to ~/Library/Logs/ghost-sync.log so the menu's "View
/// Logs" entry shows real output.
@MainActor
final class DaemonSupervisor: ObservableObject {
    @Published private(set) var isRunning: Bool = false
    @Published private(set) var lastError: String?

    private var process: Process?
    private var restartCount: Int = 0
    private let maxRestartsPerMinute: Int = 5
    private var restartWindowStart: Date = .distantPast
    private var intentionalShutdown: Bool = false

    /// Start the daemon. Idempotent — calling while running is a no-op.
    func start() {
        if isRunning { return }
        guard let node = Paths.nodeBinary() else {
            lastError = "Could not locate the node runtime. Reinstall Specter."
            return
        }
        guard let entry = Paths.daemonEntry() else {
            lastError = "Could not locate daemon.mjs in the app bundle."
            return
        }
        intentionalShutdown = false
        spawn(node: node, entry: entry)
    }

    /// Stop the daemon. Safe to call when not running.
    func stop() {
        intentionalShutdown = true
        guard let p = process, p.isRunning else {
            isRunning = false
            return
        }
        p.terminate()
        // Brief grace period before SIGKILL, on a background thread so we
        // don't block the main run loop.
        let pid = p.processIdentifier
        DispatchQueue.global().async {
            usleep(500_000)
            if kill(pid, 0) == 0 {
                kill(pid, SIGKILL)
            }
        }
    }

    /// Restart the daemon. Used after onboarding when config changes.
    func restart() {
        stop()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
            self?.start()
        }
    }

    private func spawn(node: URL, entry: URL) {
        let p = Process()
        p.executableURL = node
        p.arguments = [entry.path, "watch"]

        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin")
        p.environment = env

        // Append logs to the same file the CLI uses, so the menu's "View Logs"
        // shows the live daemon output.
        let logURL = Paths.logPath
        try? FileManager.default.createDirectory(
            at: logURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
        if let handle = try? FileHandle(forWritingTo: logURL) {
            _ = try? handle.seekToEnd()
            p.standardOutput = handle
            p.standardError = handle
        }

        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                self?.handleTermination(status: proc.terminationStatus)
            }
        }

        do {
            try p.run()
            self.process = p
            self.isRunning = true
            self.lastError = nil
        } catch {
            self.lastError = "Failed to start daemon: \(error.localizedDescription)"
            self.isRunning = false
        }
    }

    private func handleTermination(status: Int32) {
        isRunning = false
        process = nil
        if intentionalShutdown { return }

        // Rate-limit restarts so a misconfiguration that exits immediately
        // doesn't peg the CPU.
        let now = Date()
        if now.timeIntervalSince(restartWindowStart) > 60 {
            restartWindowStart = now
            restartCount = 0
        }
        restartCount += 1
        if restartCount > maxRestartsPerMinute {
            lastError = "Daemon crashed too many times. Check the log."
            return
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            self?.start()
        }
    }
}
