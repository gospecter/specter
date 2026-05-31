import AppKit
import Foundation
import SwiftUI

/// Shopify has no in-app connect form — stores are added through the web OAuth
/// flow (`spectersync.com/connect-shopify`), which mints the target with the
/// base kind `["article"]` and no chance for the user to pick kinds at
/// creation. This window fills that gap on the EDIT side: it lets the user
/// change which content kinds an already-connected Shopify store syncs (and
/// relabel it), persisting through `ConfigStore.upsertShopifyTarget` with an
/// explicit `contentKinds`. Credentials are never editable here — re-auth is
/// still the web flow.
@MainActor
final class ShopifyConnectController: ObservableObject {
    @Published var label: String = ""
    @Published var shopDisplay: String = ""
    /// Content kinds to sync, pre-filled from the target on open.
    @Published var contentKinds: [String] = []
    @Published var saveError: String?

    /// Always set — this controller is edit-only (no creation path).
    @Published var editingHandle: String?

    /// Credentials carried through unchanged so the upsert can rewrite the
    /// adapter without dropping the OAuth tokens.
    private var shop: String = ""
    private var accessToken: String = ""
    private var refreshToken: String?
    private var accessTokenExpiresAt: String?
    private var refreshTokenExpiresAt: String?

    func reset() {
        label = ""
        shopDisplay = ""
        contentKinds = []
        saveError = nil
        editingHandle = nil
        shop = ""
        accessToken = ""
        refreshToken = nil
        accessTokenExpiresAt = nil
        refreshTokenExpiresAt = nil
    }

    /// Pre-fill from an existing Shopify target for the Edit flow.
    func loadForEditing(_ target: TargetConfig) {
        guard case .shopify(let s) = target.adapter else { return }
        editingHandle = target.handle
        label = target.label
        shopDisplay = s.shop
        contentKinds = target.contentKinds
        shop = s.shop
        accessToken = s.accessToken
        refreshToken = s.refreshToken
        accessTokenExpiresAt = s.accessTokenExpiresAt
        refreshTokenExpiresAt = s.refreshTokenExpiresAt
        saveError = nil
    }

    func save(completion: @escaping (Bool) -> Void) {
        do {
            try ConfigStore.upsertShopifyTarget(
                shop: shop,
                accessToken: accessToken,
                refreshToken: refreshToken,
                accessTokenExpiresAt: accessTokenExpiresAt,
                refreshTokenExpiresAt: refreshTokenExpiresAt,
                scope: nil,
                contentKinds: contentKinds,
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

struct ShopifyConnectView: View {
    @ObservedObject var controller: ShopifyConnectController
    var onSave: () -> Void
    var onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Edit Shopify store")
                .font(.largeTitle).bold()
                .padding(.horizontal, 24)
                .padding(.top, 24)
            Text("Re-authorize a Shopify store from the Shopify connect page. Here you choose what it syncs.")
                .foregroundStyle(.secondary)
                .padding(.horizontal, 24)
                .padding(.top, 4)
                .padding(.bottom, 18)

            Form {
                Section("Store") {
                    TextField("Label (optional)", text: $controller.label,
                              prompt: Text("My Shopify store"))
                    LabeledContent("Store", value: controller.shopDisplay)
                }

                Section {
                    ContentKindSelector(platform: .shopify,
                                        selected: $controller.contentKinds)
                } header: {
                    Text("What to sync")
                } footer: {
                    Text("Choose what to sync. Both directions — only ticked kinds pull from and push to Shopify.")
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
                .keyboardShortcut(.defaultAction)
            }
            .padding(16)
        }
        .frame(width: 560, height: 420)
    }
}
