import AppKit
import Foundation
import SwiftUI

@MainActor
final class SettingsController: ObservableObject {
    @Published var draft = DaemonConfig()
    @Published var testResult: OnboardingController.TestResult = .untested
    @Published var isTesting = false
    @Published var saveError: String?

    func preload() {
        if let existing = ConfigStore.load() {
            draft = existing
        }
        testResult = .untested
        saveError = nil
    }

    var canSave: Bool {
        !draft.ghostUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !draft.adminApiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !draft.vaultPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        ["ask", "keep_local", "keep_remote"].contains(draft.conflictStrategy)
    }

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

struct SettingsView: View {
    @ObservedObject var controller: SettingsController
    @ObservedObject var license: LicenseController
    var onSave: () -> Void
    var onCancel: () -> Void

    @State private var keyInput: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Settings")
                .font(.largeTitle).bold()
                .padding(.horizontal, 24)
                .padding(.top, 24)
            Text("Change your Ghost connection, local sync folder, and conflict behavior.")
                .foregroundStyle(.secondary)
                .padding(.horizontal, 24)
                .padding(.top, 4)
                .padding(.bottom, 18)

            Form {
                Section("Ghost") {
                    TextField("Ghost URL", text: $controller.draft.ghostUrl)
                        .onChange(of: controller.draft.ghostUrl) { _ in
                            controller.testResult = .untested
                        }
                    SecureField("Admin API Key", text: $controller.draft.adminApiKey)
                        .onChange(of: controller.draft.adminApiKey) { _ in
                            controller.testResult = .untested
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

                        testResultView
                    }
                }

                Section("Local Folder") {
                    HStack {
                        Text(displayPath)
                            .foregroundStyle(controller.draft.vaultPath.isEmpty ? .secondary : .primary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer()
                        Button("Choose Folder…") { pickFolder() }
                    }
                    if controller.hasLegacyFolderLayout {
                        Label("Using legacy vault layout: \(controller.draft.syncFolderPath)", systemImage: "info.circle")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Section("License") {
                    licenseSection
                }

                Section("Sync") {
                    Picker("Sync mode", selection: $controller.draft.syncMode) {
                        Text("Watch and sync automatically").tag("auto")
                        Text("Manual sync only").tag("manual")
                    }
                    Text(syncModeHelp)
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    Toggle("Pull drafts", isOn: $controller.draft.pullDrafts)
                    Toggle("Pull published posts", isOn: $controller.draft.pullPublished)
                    Picker("Conflict strategy", selection: $controller.draft.conflictStrategy) {
                        Text("Ask every time").tag("ask")
                        Text("Keep local changes").tag("keep_local")
                        Text("Keep Ghost changes").tag("keep_remote")
                    }
                    Text(conflictHelp)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .formStyle(.grouped)
            .padding(.horizontal, 14)

            if let saveError = controller.saveError {
                Label(saveError, systemImage: "xmark.octagon.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(.horizontal, 24)
                    .padding(.bottom, 8)
            }

            Divider()
            HStack {
                Spacer()
                Button("Cancel", action: onCancel)
                Button("Save") {
                    controller.save { success in
                        if success { onSave() }
                    }
                }
                .disabled(!controller.canSave)
                .keyboardShortcut(.defaultAction)
            }
            .padding(16)
        }
        .frame(width: 620, height: 560)
    }

    @ViewBuilder
    private var testResultView: some View {
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

    private var conflictHelp: String {
        switch controller.draft.conflictStrategy {
        case "keep_local":
            return "When both sides changed, local markdown wins automatically."
        case "keep_remote":
            return "When both sides changed, Ghost wins automatically."
        default:
            return "When both sides changed, Specter asks before overwriting either side."
        }
    }

    private var syncModeHelp: String {
        switch controller.draft.syncMode {
        case "manual":
            return "Specter watches for remote changes but never pushes on its own. Use Sync Now / Push when you're ready."
        default:
            return "Saves to your local markdown push to Ghost automatically (after a short debounce)."
        }
    }

    /// License-section content. Three states: loading, Free (with counter +
    /// activate input), and Pro (with masked key + deactivate button).
    @ViewBuilder
    private var licenseSection: some View {
        switch license.state {
        case .loading:
            HStack { ProgressView().controlSize(.small); Text("Loading license…").foregroundStyle(.secondary) }

        case .failed(let msg):
            Label(msg, systemImage: "xmark.octagon.fill")
                .foregroundStyle(.red)
                .font(.caption)

        case .loaded(let status):
            if status.tier == "pro" {
                proView(status: status)
            } else {
                freeView(status: status)
            }
        }
    }

    @ViewBuilder
    private func freeView(status: LicenseStatus) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Label("Free", systemImage: "person")
                    .font(.subheadline.weight(.semibold))
                Text("\(status.syncCount) of \(status.freeLimit) uploads used this month")
                    .font(.caption)
                    .foregroundStyle(status.remainingFree == 0 ? .red : .secondary)
            }
            Spacer()
            Button {
                NSWorkspace.shared.open(MenuActions.buyProURL)
            } label: {
                Label("Buy Specter Pro — $49", systemImage: "cart")
            }
        }

        VStack(alignment: .leading, spacing: 6) {
            Text("Have a license key? Paste it here:").font(.caption).foregroundStyle(.secondary)
            HStack {
                SecureField("XXXX-XXXX-XXXX-XXXX", text: $keyInput)
                    .textFieldStyle(.roundedBorder)
                Button {
                    let key = keyInput.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !key.isEmpty else { return }
                    license.activate(key: key) { success in
                        if success { keyInput = "" }
                    }
                } label: {
                    if license.isActivating {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Activate")
                    }
                }
                .disabled(keyInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || license.isActivating)
            }
            if let err = license.lastError {
                Label(err, systemImage: "xmark.octagon.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .lineLimit(3)
            }
        }
    }

    @ViewBuilder
    private func proView(status: LicenseStatus) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Label("Specter Pro", systemImage: "checkmark.seal.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.green)
                Text("Key: \(status.key ?? "—")")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let validated = status.lastValidatedAt {
                    Text("Last validated: \(validated)")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            Spacer()
            Button {
                if let url = URL(string: "mailto:support@spectersync.com") {
                    NSWorkspace.shared.open(url)
                }
            } label: {
                Text("Contact Support")
            }
        }
        HStack {
            Text("\(status.syncCount) uploads this month (no limit)")
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            Button(role: .destructive) {
                license.deactivate { _ in }
            } label: {
                Text("Deactivate on this Mac")
            }
        }
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
            controller.draft.syncFolderPath = ""
        }
    }
}
