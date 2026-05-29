import Foundation
import SwiftUI

/// Mirror of `ghost-sync license status --json` output. The CLI is the source
/// of truth for license state — Swift never edits license.json directly.
struct LicenseStatus: Decodable {
    var tier: String           // "free" or "pro"
    var key: String?           // masked, e.g. "ABCD…WXYZ"
    var activatedAt: String?
    var lastValidatedAt: String?
    var proActiveOffline: Bool
    var monthBucket: String
    var syncCount: Int
    var freeLimit: Int
    var remainingFree: Int?    // null when Pro (unlimited)
}

/// Wraps a `ghost-sync license <subcommand>` call. Two response shapes:
///   - success: `{ok: true, ...status...}`
///   - error: `{ok: false, error: "..."}`
struct LicenseResult: Decodable {
    var ok: Bool
    var error: String?
}

/// Wrapper so we can use Swift's `Result<Data, _>` for runLicense.
struct LicenseRunError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

@MainActor
final class LicenseController: ObservableObject {
    enum State {
        case loading
        case loaded(LicenseStatus)
        case failed(String)
    }

    @Published var state: State = .loading
    @Published var isActivating = false
    @Published var lastError: String?

    /// Refresh by calling `ghost-sync license status --json`.
    func refresh() {
        state = .loading
        lastError = nil
        DispatchQueue.global().async {
            let result = self.runLicense(["status", "--json"])
            DispatchQueue.main.async {
                switch result {
                case .success(let data):
                    if let status = try? JSONDecoder().decode(LicenseStatus.self, from: data) {
                        self.state = .loaded(status)
                    } else {
                        self.state = .failed("Couldn't parse license status.")
                    }
                case .failure(let err): let msg = err.message
                    self.state = .failed(msg)
                }
            }
        }
    }

    func activate(key: String, completion: @escaping (Bool) -> Void) {
        guard !isActivating else { return }
        isActivating = true
        lastError = nil
        DispatchQueue.global().async {
            let result = self.runLicense(["activate", key, "--json"])
            DispatchQueue.main.async {
                self.isActivating = false
                switch result {
                case .success(let data):
                    if let parsed = try? JSONDecoder().decode(LicenseResult.self, from: data),
                       parsed.ok {
                        self.refresh()
                        completion(true)
                    } else {
                        let msg = (try? JSONDecoder().decode(LicenseResult.self, from: data))?.error
                            ?? "Activation failed."
                        self.lastError = msg
                        completion(false)
                    }
                case .failure(let err): let msg = err.message
                    self.lastError = msg
                    completion(false)
                }
            }
        }
    }

    func deactivate(completion: @escaping (Bool) -> Void) {
        DispatchQueue.global().async {
            let result = self.runLicense(["deactivate", "--json"])
            DispatchQueue.main.async {
                switch result {
                case .success:
                    self.refresh()
                    completion(true)
                case .failure(let err): let msg = err.message
                    self.lastError = msg
                    completion(false)
                }
            }
        }
    }

    /// Convenience: synchronous-style accessor for the current tier.
    /// Returns nil if we haven't loaded yet.
    var tier: String? {
        if case .loaded(let status) = state { return status.tier }
        return nil
    }

    var isPro: Bool { tier == "pro" }
    var isFree: Bool { tier == "free" }

    private func runLicense(_ args: [String]) -> Result<Data, LicenseRunError> {
        guard let node = Paths.nodeBinary(), let entry = Paths.daemonEntry() else {
            return .failure(LicenseRunError(message: "Bundled daemon not found."))
        }
        let task = Process()
        task.executableURL = node
        task.arguments = [entry.path, "license"] + args
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin")
        task.environment = env
        let out = Pipe()
        let err = Pipe()
        task.standardOutput = out
        task.standardError = err

        do {
            try task.run()
            task.waitUntilExit()
            let data = out.fileHandleForReading.readDataToEndOfFile()
            if task.terminationStatus == 0 {
                return .success(data)
            }
            // Non-zero exit may still have a JSON {ok:false} body on stdout.
            if !data.isEmpty { return .success(data) }
            let stderr = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            return .failure(LicenseRunError(message: stderr.isEmpty ? "License command failed." : stderr))
        } catch {
            return .failure(LicenseRunError(message: error.localizedDescription))
        }
    }
}
