import AppKit
import Foundation

@MainActor
final class OAuthController: NSObject {
    static let shared = OAuthController()

    var lastMessage: String?

    private let exchangeEndpoint = URL(string: "https://spectersync.com/api/oauth/shopify/exchange")!

    func register() {
        NSAppleEventManager.shared().setEventHandler(
            self,
            andSelector: #selector(handleGetURLEvent(_:withReplyEvent:)),
            forEventClass: AEEventClass(kInternetEventClass),
            andEventID: AEEventID(kAEGetURL)
        )
    }

    func warnIfProtocolOwnerMismatch() {
        guard Bundle.main.bundleIdentifier != nil,
              let callback = URL(string: "specter://oauth/complete"),
              let owner = NSWorkspace.shared.urlForApplication(toOpen: callback) else { return }

        let current = Bundle.main.bundleURL.standardizedFileURL
        if owner.standardizedFileURL != current {
            show(
                "Specter OAuth needs attention",
                "Another app appears to own specter:// links. Reinstall or relaunch Specter before connecting Shopify."
            )
        }
    }

    @objc private func handleGetURLEvent(_ event: NSAppleEventDescriptor, withReplyEvent: NSAppleEventDescriptor) {
        guard let raw = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue,
              let url = URL(string: raw) else { return }
        handle(url)
    }

    func handle(_ url: URL) {
        guard url.scheme == "specter",
              url.host == "oauth",
              url.path == "/complete" else { return }

        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let provider = components.queryItems?.first(where: { $0.name == "provider" })?.value,
              provider == "shopify",
              let shop = components.queryItems?.first(where: { $0.name == "shop" })?.value,
              let code = components.queryItems?.first(where: { $0.name == "code" })?.value,
              !shop.isEmpty,
              !code.isEmpty else {
            show("Shopify connection failed", "The OAuth callback was missing required details.")
            return
        }

        Task {
            do {
                let token = try await exchangeShopifyCode(code)
                try ConfigStore.upsertShopifyTarget(
                    shop: token.shop,
                    accessToken: token.accessToken,
                    refreshToken: token.refreshToken,
                    accessTokenExpiresAt: token.accessTokenExpiresAt,
                    refreshTokenExpiresAt: token.refreshTokenExpiresAt,
                    scope: token.scope
                )
                lastMessage = "Connected Shopify store \(token.shop)."
                show("Shopify connected", "Specter can now sync Shopify articles for \(token.shop).")
            } catch {
                show("Shopify connection failed", error.localizedDescription)
            }
        }
    }

    private func exchangeShopifyCode(_ code: String) async throws -> ShopifyExchangeResponse {
        var request = URLRequest(url: exchangeEndpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONEncoder().encode(["code": code])

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw OAuthError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            let apiError = try? JSONDecoder().decode(OAuthAPIError.self, from: data)
            throw OAuthError.exchangeFailed(apiError?.error ?? "HTTP \(http.statusCode)")
        }
        return try JSONDecoder().decode(ShopifyExchangeResponse.self, from: data)
    }

    private func show(_ title: String, _ message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = title.contains("failed") ? .warning : .informational
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }
}

struct ShopifyExchangeResponse: Decodable {
    let provider: String
    let shop: String
    let accessToken: String
    let refreshToken: String?
    let accessTokenExpiresAt: String?
    let refreshTokenExpiresAt: String?
    let scope: String?
}

struct OAuthAPIError: Decodable {
    let error: String
}

enum OAuthError: LocalizedError {
    case invalidResponse
    case exchangeFailed(String)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "The Shopify token exchange returned an invalid response."
        case .exchangeFailed(let detail):
            return detail
        }
    }
}

/// Delivers `specter://` URLs to `OAuthController` via SwiftUI's
/// `@NSApplicationDelegateAdaptor`. SwiftUI installs its own `kAEGetURL`
/// Apple Event handler and silently drops URLs when neither `.onOpenURL`
/// nor `NSApplicationDelegate.application(_:open:)` is implemented, so the
/// legacy `setEventHandler` registration alone is not enough.
final class SpecterAppDelegate: NSObject, NSApplicationDelegate {
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            OAuthController.shared.handle(url)
        }
    }
}
