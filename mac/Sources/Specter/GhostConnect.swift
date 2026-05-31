import AppKit
import Foundation
import SwiftUI

/// Standalone window for adding (or editing) a Ghost blog in `targets[]`.
///
/// Mirrors `WordPressConnectController`/`WordPressConnectView` but talks to
/// `ConfigStore.upsertGhostTarget`, so a second, third, … Ghost blog can be
/// added without the legacy single-Ghost onboarding overwriting the first.
/// Each new blog gets a unique slugified handle and its own vault folder.
@MainActor
final class GhostConnectController: ObservableObject {
    @Published var label: String = ""
    @Published var ghostUrl: String = ""
    @Published var adminApiKey: String = ""
    /// Content kinds the user has ticked to sync. Opt-in: empty for a new
    /// connection (nothing pre-checked); pre-filled from the target when editing.
    @Published var contentKinds: [String] = []
    @Published var testResult: OnboardingController.TestResult = .untested
    @Published var isTesting = false
    @Published var saveError: String?

    /// Set when the form is opened to edit an existing target. Drives an
    /// in-place upsert (no new handle minted) and the window's title/CTA copy.
    @Published var editingHandle: String?

    var isEditing: Bool { editingHandle != nil }

    var canTest: Bool {
        !ghostUrl.trimmingCharacters(in: .whitespaces).isEmpty &&
        !adminApiKey.trimmingCharacters(in: .whitespaces).isEmpty &&
        !isTesting
    }

    var canSave: Bool {
        if case .ok = testResult { return true }
        return false
    }

    func reset() {
        label = ""
        ghostUrl = ""
        adminApiKey = ""
        contentKinds = []   // new connection: nothing pre-checked (opt-in).
        testResult = .untested
        saveError = nil
        isTesting = false
        editingHandle = nil
    }

    /// Pre-fill the form from an existing Ghost target for the Edit flow.
    func loadForEditing(_ target: TargetConfig) {
        guard case .ghost(let g) = target.adapter else { return }
        editingHandle = target.handle
        label = target.label
        ghostUrl = g.ghostUrl
        adminApiKey = g.adminApiKey
        contentKinds = target.contentKinds   // edit: pre-fill from current.
        testResult = .untested
        saveError = nil
        isTesting = false
    }

    func runTest() {
        let url = ghostUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = adminApiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        isTesting = true
        testResult = .untested
        DispatchQueue.global().async {
            let result = ConnectionTester.run(url: url, key: key)
            DispatchQueue.main.async {
                self.isTesting = false
                self.testResult = result
            }
        }
    }

    func save(completion: @escaping (Bool) -> Void) {
        let url = ghostUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = adminApiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            try ConfigStore.upsertGhostTarget(
                ghostUrl: url,
                adminApiKey: key,
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

struct GhostConnectView: View {
    @ObservedObject var controller: GhostConnectController
    var onSave: () -> Void
    var onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(controller.isEditing ? "Edit Ghost blog" : "Add a Ghost blog")
                .font(.largeTitle).bold()
                .padding(.horizontal, 24)
                .padding(.top, 24)
            Text("Find your Admin API key under Ghost Admin → Settings → Integrations → Add custom integration.")
                .foregroundStyle(.secondary)
                .padding(.horizontal, 24)
                .padding(.top, 4)
                .padding(.bottom, 18)

            Form {
                Section("Blog") {
                    TextField("Label (optional)", text: $controller.label,
                              prompt: Text("My Ghost blog"))
                    TextField("Ghost URL", text: $controller.ghostUrl,
                              prompt: Text("https://yourblog.ghost.io"))
                        .onChange(of: controller.ghostUrl) { _ in
                            controller.testResult = .untested
                        }
                    SecureField("Admin API Key", text: $controller.adminApiKey,
                                prompt: Text("id:secret"))
                        .onChange(of: controller.adminApiKey) { _ in
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
                        .disabled(!controller.canTest)

                        testResultView
                    }
                }

                Section {
                    ContentKindSelector(platform: .ghost,
                                        selected: $controller.contentKinds)
                } header: {
                    Text("What to sync")
                } footer: {
                    Text("Choose what to sync. Both directions — only ticked kinds pull from and push to Ghost.")
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
