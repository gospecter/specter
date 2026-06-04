import AppKit
import Foundation
import SwiftUI

/// Standalone window for adding a Webflow site to `targets[]`.
///
/// Differs from the WordPress form in two ways:
///  - Auth is a single bearer token (a pasted Site API token, or an OAuth token
///    pre-filled by the deep-link handler).
///  - Content kinds are DYNAMIC — the site's CMS collections. They can't be
///    hard-coded, so after a successful Test Connection the form fetches them via
///    the daemon `kinds` command and renders a checkbox per collection.
@MainActor
final class WebflowConnectController: ObservableObject {
    @Published var label: String = ""
    @Published var siteId: String = ""
    @Published var apiToken: String = ""
    @Published var contentKinds: [String] = []
    /// Live collections discovered for the tested site (`webflow:<slug>`).
    @Published var availableKinds: [String] = []
    @Published var testResult: OnboardingController.TestResult = .untested
    @Published var isTesting = false
    @Published var saveError: String?

    @Published var editingHandle: String?

    /// Credentials as loaded for an edit. Used to tell a label/content-kind-only
    /// edit (creds untouched → already validated, save without re-test) from a
    /// credential change (must re-test).
    private var loadedSiteId = ""
    private var loadedApiToken = ""

    var isEditing: Bool { editingHandle != nil }

    var canTest: Bool {
        !siteId.trimmingCharacters(in: .whitespaces).isEmpty &&
        !apiToken.trimmingCharacters(in: .whitespaces).isEmpty &&
        !isTesting
    }

    /// True when editing an existing target whose credentials are unchanged from
    /// what was loaded — already validated when added, so a label or content-kind
    /// tweak shouldn't demand a fresh Test (which also re-fetches collections).
    private var isUnchangedCredentialEdit: Bool {
        isEditing &&
        siteId.trimmingCharacters(in: .whitespacesAndNewlines) == loadedSiteId &&
        apiToken.trimmingCharacters(in: .whitespacesAndNewlines) == loadedApiToken
    }

    var canSave: Bool {
        if case .ok = testResult { return true }
        // Editing an already-connected site: allow saving label / content-kind
        // changes without forcing a re-test. Changing the site id or token flips
        // this false (and onChange resets testResult), so credential edits still
        // require a successful Test before Save re-enables.
        return isUnchangedCredentialEdit
    }

    func reset() {
        label = ""
        siteId = ""
        apiToken = ""
        contentKinds = []
        availableKinds = []
        testResult = .untested
        saveError = nil
        isTesting = false
        editingHandle = nil
        loadedSiteId = ""
        loadedApiToken = ""
    }

    /// Pre-fill from an existing Webflow target for the Edit flow.
    func loadForEditing(_ target: TargetConfig) {
        guard case .webflow(let wf) = target.adapter else { return }
        editingHandle = target.handle
        label = target.label
        siteId = wf.siteId
        apiToken = wf.apiToken ?? wf.accessToken ?? ""
        loadedSiteId = wf.siteId.trimmingCharacters(in: .whitespacesAndNewlines)
        loadedApiToken = (wf.apiToken ?? wf.accessToken ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        contentKinds = target.contentKinds
        availableKinds = target.contentKinds   // seed; refreshed on Test
        testResult = .untested
        saveError = nil
        isTesting = false
    }

    /// Pre-fill from a completed OAuth flow: the token is known, the site is not.
    func loadFromOAuth(token: String) {
        reset()
        apiToken = token
    }

    func runTest() {
        let site = siteId.trimmingCharacters(in: .whitespacesAndNewlines)
        let token = apiToken.trimmingCharacters(in: .whitespacesAndNewlines)
        isTesting = true
        testResult = .untested
        DispatchQueue.global().async {
            let result = ConnectionTester.runWebflow(siteId: site, apiToken: token)
            // On success, also pull the live collection list for the kind picker.
            var kinds: [String]? = nil
            if case .ok = result {
                kinds = ConnectionTester.runWebflowKinds(siteId: site, apiToken: token)
            }
            DispatchQueue.main.async {
                self.isTesting = false
                self.testResult = result
                if let kinds { self.availableKinds = kinds }
            }
        }
    }

    func save(completion: @escaping (Bool) -> Void) {
        let site = siteId.trimmingCharacters(in: .whitespacesAndNewlines)
        let token = apiToken.trimmingCharacters(in: .whitespacesAndNewlines)
        // Only persist kinds the tested site actually exposes.
        let kinds = contentKinds.filter { availableKinds.contains($0) }
        do {
            try ConfigStore.upsertWebflowTarget(
                siteId: site,
                apiToken: token,
                accessToken: nil,
                contentKinds: kinds,
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

struct WebflowConnectView: View {
    @ObservedObject var controller: WebflowConnectController
    var onSave: () -> Void
    var onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(controller.isEditing ? "Edit Webflow site" : "Add a Webflow site")
                .font(.largeTitle).bold()
                .padding(.horizontal, 24)
                .padding(.top, 24)
            Text("Paste a Site API token, or finish an OAuth connection. Specter syncs your CMS collections to markdown.")
                .foregroundStyle(.secondary)
                .padding(.horizontal, 24)
                .padding(.top, 4)
                .padding(.bottom, 18)

            Form {
                if !controller.isEditing {
                    Section {
                        Button {
                            if let url = OAuthController.endpointURL("/api/oauth/webflow/start") {
                                OAuthController.shared.startInApp(url)
                            }
                        } label: {
                            Label("Connect with Webflow", systemImage: "link")
                        }
                        Text("Authorize Webflow in a secure window — Specter fills in the token and site for you. Or paste a Site API token below instead.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } header: {
                        Text("Recommended")
                    }
                }

                Section("Site") {
                    TextField("Label (optional)", text: $controller.label,
                              prompt: Text("e.g. My Webflow site"))
                    TextField("Site ID", text: $controller.siteId,
                              prompt: Text("Webflow site ID"))
                        .onChange(of: controller.siteId) { _ in
                            controller.testResult = .untested
                        }
                    SecureField("API token", text: $controller.apiToken)
                        .onChange(of: controller.apiToken) { _ in
                            controller.testResult = .untested
                        }
                    Button {
                        if let url = URL(string: "https://developers.webflow.com/data/reference/authentication") {
                            NSWorkspace.shared.open(url)
                        }
                    } label: {
                        Label("How to create a Webflow Site API token",
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
                    if controller.availableKinds.isEmpty {
                        Text("Run Test Connection to load this site's CMS collections.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        ContentKindSelector(platform: .webflow,
                                            selected: $controller.contentKinds,
                                            availableKinds: controller.availableKinds)
                    }
                } header: {
                    Text("Collections to sync")
                } footer: {
                    Text("Choose which collections to sync. Both directions — only ticked collections pull from and push to Webflow.")
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
