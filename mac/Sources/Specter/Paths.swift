import Foundation

/// Resolve filesystem locations the app cares about.
///
/// Two discovery modes:
///   - **Bundled**: production .app with node + daemon.bundle.js inside
///     `Contents/Resources/`. This is the path end users see.
///   - **Dev**: running from `swift run` or from a non-bundled binary. We fall
///     back to PATH lookup and the state.json hints written by an earlier CLI
///     invocation. Lets developers iterate without rebuilding the .app every
///     time.
enum Paths {
    static var homeDir: URL { FileManager.default.homeDirectoryForCurrentUser }

    static var configPath: URL {
        let base = ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"]
            .map { URL(fileURLWithPath: $0) } ?? homeDir.appending(path: ".config")
        return base.appending(path: "ghost-sync/config.json")
    }

    static var statePath: URL {
        let base = ProcessInfo.processInfo.environment["XDG_STATE_HOME"]
            .map { URL(fileURLWithPath: $0) } ?? homeDir.appending(path: ".local/state")
        return base.appending(path: "ghost-sync/state.json")
    }

    static var logPath: URL {
        homeDir.appending(path: "Library/Logs/ghost-sync.log")
    }

    /// Path to the node binary bundled inside the .app, if present.
    static var bundledNode: URL? {
        guard let resources = Bundle.main.resourceURL else { return nil }
        let candidate = resources.appending(path: "node")
        return FileManager.default.isExecutableFile(atPath: candidate.path) ? candidate : nil
    }

    /// Path to the bundled daemon entry point inside the .app.
    static var bundledDaemon: URL? {
        guard let resources = Bundle.main.resourceURL else { return nil }
        let candidate = resources.appending(path: "daemon.mjs")
        return FileManager.default.fileExists(atPath: candidate.path) ? candidate : nil
    }

    static func nodeBinary() -> URL? {
        if let bundled = bundledNode { return bundled }
        if let stateNode = readNodeFromState(),
           FileManager.default.isExecutableFile(atPath: stateNode) {
            return URL(fileURLWithPath: stateNode)
        }
        if let p = which("node") { return URL(fileURLWithPath: p) }
        for p in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] + nvmNodeCandidates() {
            if FileManager.default.isExecutableFile(atPath: p) {
                return URL(fileURLWithPath: p)
            }
        }
        return nil
    }

    /// Resolves the script Node should run. Bundled .app: daemon.mjs in
    /// Resources. Dev: the npm-linked CLI binary.
    static func daemonEntry() -> URL? {
        if let bundled = bundledDaemon { return bundled }
        if let stateBin = readBinaryFromState(),
           FileManager.default.isReadableFile(atPath: stateBin) {
            return URL(fileURLWithPath: stateBin)
        }
        if let p = which("ghost-sync") { return URL(fileURLWithPath: p) }
        for p in ["/opt/homebrew/bin/ghost-sync", "/usr/local/bin/ghost-sync"]
                + nvmCandidates() {
            if FileManager.default.isReadableFile(atPath: p) {
                return URL(fileURLWithPath: p)
            }
        }
        return nil
    }

    private static func readBinaryFromState() -> String? {
        guard let data = try? Data(contentsOf: statePath),
              let state = try? JSONDecoder().decode(DaemonState.self, from: data) else { return nil }
        return state.binaryPath
    }

    private static func readNodeFromState() -> String? {
        guard let data = try? Data(contentsOf: statePath),
              let state = try? JSONDecoder().decode(DaemonState.self, from: data) else { return nil }
        return state.nodePath
    }

    private static func nvmCandidates() -> [String] {
        let nvmDir = homeDir.appending(path: ".nvm/versions/node")
        guard let entries = try? FileManager.default.contentsOfDirectory(atPath: nvmDir.path)
            else { return [] }
        return entries.sorted(by: >).map { nvmDir.appending(path: "\($0)/bin/ghost-sync").path }
    }

    private static func nvmNodeCandidates() -> [String] {
        let nvmDir = homeDir.appending(path: ".nvm/versions/node")
        guard let entries = try? FileManager.default.contentsOfDirectory(atPath: nvmDir.path)
            else { return [] }
        return entries.sorted(by: >).map { nvmDir.appending(path: "\($0)/bin/node").path }
    }

    private static func which(_ name: String) -> String? {
        let task = Process()
        task.launchPath = "/usr/bin/env"
        task.arguments = ["which", name]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = Pipe()
        do { try task.run() } catch { return nil }
        task.waitUntilExit()
        guard task.terminationStatus == 0 else { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let str = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (str?.isEmpty ?? true) ? nil : str
    }
}
