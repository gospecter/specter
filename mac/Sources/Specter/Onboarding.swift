import AppKit
import Foundation
import SwiftUI

/// First-run wizard. Walks the user from "no config" to a working daemon
/// without ever opening Terminal:
///   1. Welcome
///   2. Ghost URL + API key, with a Test Connection button
///   3. Pick the local folder where markdown lives
///   4. Save → daemon supervisor starts
@MainActor
final class OnboardingController: ObservableObject {
    @Published var step: Step = .welcome
    @Published var draft = DaemonConfig()
    @Published var testResult: TestResult = .untested
    @Published var isTesting = false
    @Published var saveError: String?

    enum Step: Int, CaseIterable { case welcome, credentials, folder, done }

    enum TestResult: Equatable {
        case untested
        case ok(String)
        case failed(String)
    }

    /// Hydrate with any existing config so re-running onboarding doesn't
    /// destroy what the user already entered.
    func preload() {
        if let existing = ConfigStore.load() {
            draft = existing
        } else {
            // Sensible default: their home folder, which the picker will narrow.
            draft.vaultPath = FileManager.default.homeDirectoryForCurrentUser.path
        }
    }

    func next() {
        if let nextStep = Step(rawValue: step.rawValue + 1) {
            step = nextStep
        }
    }

    func back() {
        if let prev = Step(rawValue: step.rawValue - 1) {
            step = prev
        }
    }

    var canContinueFromCredentials: Bool {
        guard !draft.ghostUrl.trimmingCharacters(in: .whitespaces).isEmpty,
              !draft.adminApiKey.trimmingCharacters(in: .whitespaces).isEmpty
        else { return false }
        if case .ok = testResult { return true }
        return false
    }

    var canContinueFromFolder: Bool {
        !draft.vaultPath.isEmpty
    }

    /// Whether the user's existing config still uses the legacy two-path
    /// layout (vault root + relative sync folder). New configs use a single
    /// absolute path stored in vaultPath with syncFolderPath empty.
    var hasLegacyFolderLayout: Bool {
        !draft.syncFolderPath.isEmpty
    }

    func runTest() {
        isTesting = true
        testResult = .untested
        let url = draft.ghostUrl
        let key = draft.adminApiKey

        DispatchQueue.global().async {
            let result = ConnectionTester.run(url: url, key: key)
            DispatchQueue.main.async {
                self.isTesting = false
                self.testResult = result
            }
        }
    }

    /// Persist the config and signal the app to launch the daemon.
    func save(completion: @escaping (Bool) -> Void) {
        do {
            try ConfigStore.save(draft)
            saveError = nil
            completion(true)
        } catch {
            saveError = error.localizedDescription
            completion(false)
        }
    }
}

/// Calls `ghost-sync test ... --json` and parses the JSON result.
/// Works for both dev (CLI on PATH) and bundled (.app with daemon.mjs).
enum ConnectionTester {
    struct Response: Decodable { let ok: Bool; let message: String }

    static func run(url: String, key: String) -> OnboardingController.TestResult {
        runDaemonTest(args: ["test", "--url", url, "--key", key, "--json"])
    }

    /// Ad-hoc WordPress connection test. Invokes the daemon CLI with the
    /// wordpress flag set so the saved config is never touched — used by the
    /// "Add WordPress" form before the target is persisted.
    static func runWordPress(siteUrl: String, username: String, appPassword: String)
        -> OnboardingController.TestResult
    {
        runDaemonTest(args: [
            "test",
            "--platform", "wordpress",
            "--site-url", siteUrl,
            "--username", username,
            "--app-password", appPassword,
            "--json",
        ])
    }

    private static func runDaemonTest(args: [String]) -> OnboardingController.TestResult {
        guard let node = Paths.nodeBinary() else {
            return .failed("Node runtime not found.")
        }
        guard let entry = Paths.daemonEntry() else {
            return .failed("Daemon not found.")
        }
        let task = Process()
        task.executableURL = node
        task.arguments = [entry.path] + args
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin")
        task.environment = env
        let out = Pipe()
        task.standardOutput = out
        task.standardError = Pipe()
        do {
            try task.run()
            task.waitUntilExit()
            let data = out.fileHandleForReading.readDataToEndOfFile()
            if let response = try? JSONDecoder().decode(Response.self, from: data) {
                return response.ok ? .ok(response.message) : .failed(response.message)
            }
            let raw = String(data: data, encoding: .utf8) ?? ""
            return .failed(raw.isEmpty ? "Unknown error" : raw)
        } catch {
            return .failed(error.localizedDescription)
        }
    }
}

// MARK: - SwiftUI

struct OnboardingView: View {
    @ObservedObject var controller: OnboardingController
    var onFinish: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ProgressHeader(step: controller.step)
            Divider()
            Group {
                switch controller.step {
                case .welcome: WelcomeStep(onContinue: controller.next)
                case .credentials: CredentialsStep(controller: controller)
                case .folder: FolderStep(controller: controller)
                case .done: DoneStep(onFinish: {
                    controller.save { success in
                        if success { onFinish() }
                    }
                })
                }
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .frame(width: 560, height: 480)
    }
}

private struct ProgressHeader: View {
    let step: OnboardingController.Step

    var body: some View {
        HStack(spacing: 8) {
            ForEach(OnboardingController.Step.allCases, id: \.self) { s in
                Capsule()
                    .fill(s.rawValue <= step.rawValue ? Color.accentColor : Color.secondary.opacity(0.3))
                    .frame(height: 4)
            }
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 12)
    }
}

private struct WelcomeStep: View {
    var onContinue: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Welcome to Specter")
                .font(.largeTitle).bold()
            Text("Two-way sync between your Ghost blog and a folder of markdown files. We'll get you set up in three quick steps.")
                .foregroundStyle(.secondary)
            Spacer()
            HStack {
                Spacer()
                Button("Get Started", action: onContinue)
                    .keyboardShortcut(.defaultAction)
            }
        }
    }
}

private struct CredentialsStep: View {
    @ObservedObject var controller: OnboardingController

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Connect to Ghost").font(.title2).bold()
            Text("Find your Admin API key under **Ghost Admin → Settings → Integrations → Add custom integration**.")
                .font(.callout)
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 8) {
                Text("Ghost URL").font(.subheadline)
                TextField("https://yourblog.ghost.io", text: $controller.draft.ghostUrl)
                    .textFieldStyle(.roundedBorder)
                    .onChange(of: controller.draft.ghostUrl) { _ in
                        controller.testResult = .untested
                    }

                Text("Admin API Key").font(.subheadline).padding(.top, 6)
                SecureField("id:secret", text: $controller.draft.adminApiKey)
                    .textFieldStyle(.roundedBorder)
                    .onChange(of: controller.draft.adminApiKey) { _ in
                        controller.testResult = .untested
                    }
            }

            HStack(spacing: 10) {
                Button {
                    controller.runTest()
                } label: {
                    if controller.isTesting {
                        ProgressView().controlSize(.small)
                        Text("Testing…")
                    } else {
                        Label("Test Connection", systemImage: "checkmark.shield")
                    }
                }
                .disabled(controller.draft.ghostUrl.isEmpty || controller.draft.adminApiKey.isEmpty || controller.isTesting)

                Group {
                    switch controller.testResult {
                    case .untested:
                        EmptyView()
                    case .ok(let msg):
                        Label(msg, systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                    case .failed(let msg):
                        Label(msg, systemImage: "xmark.octagon.fill")
                            .foregroundStyle(.red)
                            .lineLimit(2)
                    }
                }
                .font(.caption)
            }

            Spacer()

            HStack {
                Button("Back", action: controller.back)
                Spacer()
                Button("Continue", action: controller.next)
                    .disabled(!controller.canContinueFromCredentials)
                    .keyboardShortcut(.defaultAction)
            }
        }
    }
}

private struct FolderStep: View {
    @ObservedObject var controller: OnboardingController

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Pick the sync folder").font(.title2).bold()
            Text("Choose the local folder where your Ghost posts should live. Specter watches this folder for changes and keeps it in sync with your blog.")
                .font(.callout)
                .foregroundStyle(.secondary)

            HStack {
                Text(displayPath)
                    .font(.callout)
                    .foregroundStyle(controller.draft.vaultPath.isEmpty ? .secondary : .primary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 6)
                    .background(Color.secondary.opacity(0.1))
                    .cornerRadius(6)
                Button("Choose Folder…") { pickFolder() }
                    .controlSize(.large)
            }

            if controller.hasLegacyFolderLayout {
                Label(
                    "Using legacy vault layout: \(controller.draft.syncFolderPath)",
                    systemImage: "info.circle"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            Text("Tip: this can be any folder. If you use Obsidian, point it at a folder inside your vault.")
                .font(.caption)
                .foregroundStyle(.secondary)

            Spacer()

            HStack {
                Button("Back", action: controller.back)
                Spacer()
                Button("Continue", action: controller.next)
                    .disabled(!controller.canContinueFromFolder)
                    .keyboardShortcut(.defaultAction)
            }
        }
    }

    private var displayPath: String {
        if controller.draft.vaultPath.isEmpty {
            return "No folder chosen"
        }
        if controller.hasLegacyFolderLayout {
            return URL(fileURLWithPath: controller.draft.vaultPath)
                .appending(path: controller.draft.syncFolderPath).path
        }
        return controller.draft.vaultPath
    }

    private func pickFolder() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Choose Folder"
        if panel.runModal() == .OK, let url = panel.url {
            controller.draft.vaultPath = url.standardizedFileURL.path
            // Single-picker layout: no nested sync folder. We blank it out so
            // the daemon treats vaultPath itself as the sync root.
            controller.draft.syncFolderPath = ""
        }
    }
}

private struct DoneStep: View {
    var onFinish: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Ready to sync", systemImage: "checkmark.circle.fill")
                .font(.title2).bold()
                .foregroundStyle(.green)
            Text("Specter will run quietly in your menu bar. The first full sync starts as soon as you finish setup.")
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 6) {
                Label("Auto-push when you edit files in the sync folder", systemImage: "icloud.and.arrow.up")
                Label("Periodic pull every 10 minutes for remote changes", systemImage: "icloud.and.arrow.down")
                Label("Conflict prompts when both sides change the same post", systemImage: "questionmark.circle")
            }
            .font(.callout)
            .padding(.top, 6)

            Spacer()

            HStack {
                Spacer()
                Button("Finish", action: onFinish)
                    .keyboardShortcut(.defaultAction)
            }
        }
    }
}
