import AppKit
import Foundation
import SwiftUI

/// Spec: tasks/spec-wordpress-adapter.md Phase 7.
///
/// Standalone window for adding a WordPress site to `targets[]`. Mirrors the
/// shape of the legacy Ghost Settings form but talks to `upsertWordPressTarget`
/// so the daemon picks the new target up on next restart.
@MainActor
final class WordPressConnectController: ObservableObject {
    @Published var label: String = ""
    @Published var siteUrl: String = ""
    @Published var username: String = ""
    @Published var appPassword: String = ""
    /// Content kinds the user has ticked to sync. Opt-in: empty for a new
    /// connection (nothing pre-checked); pre-filled from the target when editing.
    @Published var contentKinds: [String] = []
    @Published var testResult: OnboardingController.TestResult = .untested
    @Published var isTesting = false
    @Published var saveError: String?

    /// Set when editing an existing target — drives an in-place upsert (no new
    /// handle minted) and the window's title/CTA copy.
    @Published var editingHandle: String?

    var isEditing: Bool { editingHandle != nil }

    var canTest: Bool {
        !siteUrl.trimmingCharacters(in: .whitespaces).isEmpty &&
        !username.trimmingCharacters(in: .whitespaces).isEmpty &&
        !appPassword.trimmingCharacters(in: .whitespaces).isEmpty &&
        !isTesting
    }

    var canSave: Bool {
        if case .ok = testResult { return true }
        return false
    }

    func reset() {
        label = ""
        siteUrl = ""
        username = ""
        appPassword = ""
        contentKinds = []   // new connection: nothing pre-checked (opt-in).
        testResult = .untested
        saveError = nil
        isTesting = false
        editingHandle = nil
    }

    /// Pre-fill the form from an existing WordPress target for the Edit flow.
    func loadForEditing(_ target: TargetConfig) {
        guard case .wordpress(let w) = target.adapter else { return }
        editingHandle = target.handle
        label = target.label
        siteUrl = w.siteUrl
        username = w.username
        appPassword = w.appPassword
        contentKinds = target.contentKinds   // edit: pre-fill from current.
        testResult = .untested
        saveError = nil
        isTesting = false
    }

    func runTest() {
        let url = siteUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        let user = username.trimmingCharacters(in: .whitespacesAndNewlines)
        // Application Passwords are displayed space-grouped ("xxxx yyyy ...");
        // strip spaces before sending so the daemon's WordPressApiClient gets
        // the raw 24-char string it expects.
        let pw = appPassword.replacingOccurrences(of: " ", with: "")
        isTesting = true
        testResult = .untested
        DispatchQueue.global().async {
            let result = ConnectionTester.runWordPress(
                siteUrl: url,
                username: user,
                appPassword: pw
            )
            DispatchQueue.main.async {
                self.isTesting = false
                self.testResult = result
            }
        }
    }

    func save(completion: @escaping (Bool) -> Void) {
        let url = siteUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        let user = username.trimmingCharacters(in: .whitespacesAndNewlines)
        let pw = appPassword.replacingOccurrences(of: " ", with: "")
        do {
            try ConfigStore.upsertWordPressTarget(
                siteUrl: url,
                username: user,
                appPassword: pw,
                contentKinds: contentKinds,
                label: label,
                editingHandle: editingHandle
            )
            saveError = nil
            completion(true)
        } catch {
            saveError = error.localizedDescription
            completion(false)
        }
    }
}

struct WordPressConnectView: View {
    @ObservedObject var controller: WordPressConnectController
    var onSave: () -> Void
    var onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(controller.isEditing ? "Edit WordPress site" : "Add a WordPress site")
                .font(.largeTitle).bold()
                .padding(.horizontal, 24)
                .padding(.top, 24)
            Text("Specter signs in with WordPress Application Passwords. No plugin required.")
                .foregroundStyle(.secondary)
                .padding(.horizontal, 24)
                .padding(.top, 4)
                .padding(.bottom, 18)

            Form {
                Section("Site") {
                    TextField("Label (optional)", text: $controller.label,
                              prompt: Text("My WordPress site"))
                    TextField("Site URL", text: $controller.siteUrl,
                              prompt: Text("https://example.com"))
                        .onChange(of: controller.siteUrl) { _ in
                            controller.testResult = .untested
                        }
                    TextField("Username", text: $controller.username)
                        .onChange(of: controller.username) { _ in
                            controller.testResult = .untested
                        }
                    SecureField("Application Password", text: $controller.appPassword)
                        .onChange(of: controller.appPassword) { _ in
                            controller.testResult = .untested
                        }
                    Button {
                        if let url = URL(string: "https://wordpress.org/documentation/article/application-passwords/") {
                            NSWorkspace.shared.open(url)
                        }
                    } label: {
                        Label("How to create an Application Password",
                              systemImage: "questionmark.circle")
                            .font(.caption)
                    }
                    .buttonStyle(.link)

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
                        .disabled(!controller.canTest)

                        testResultView
                    }
                }

                Section {
                    ContentKindSelector(platform: .wordpress,
                                        selected: $controller.contentKinds)
                } header: {
                    Text("What to sync")
                } footer: {
                    Text("Choose what to sync. Both directions — only ticked kinds pull from and push to WordPress.")
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
                Button(controller.isEditing ? "Save" : "Connect") {
                    controller.save { success in
                        if success { onSave() }
                    }
                }
                .disabled(!controller.canSave)
                .keyboardShortcut(.defaultAction)
            }
            .padding(16)
        }
        .frame(width: 560, height: 480)
    }

    @ViewBuilder
    private var testResultView: some View {
        switch controller.testResult {
        case .untested:
            EmptyView()
        case .ok(let msg):
            Label(msg, systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
                .lineLimit(2)
        case .failed(let msg):
            Label(msg, systemImage: "xmark.octagon.fill")
                .foregroundStyle(.red)
                .lineLimit(2)
        }
    }
}
