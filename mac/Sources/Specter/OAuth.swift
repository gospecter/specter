import AppKit
import Foundation

@MainActor
final class OAuthController: NSObject {
    static let shared = OAuthController()

    var lastMessage: String?

    /// OAuth broker shipped with PRO. DIY users who self-host a broker override
    /// it via the `oauthBaseUrl` config field (see `DaemonConfig.oauthBaseUrl`).
    static let defaultBaseURLString = "https://spectersync.com"

    /// Origin of the OAuth broker to talk to: the configured `oauthBaseUrl`
    /// when set, otherwise the hosted default. Read fresh each call so a
    /// Settings change takes effect without relaunching.
    static var baseURLString: String {
        let configured = ConfigStore.load()?.oauthBaseUrl?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let configured, !configured.isEmpty else { return defaultBaseURLString }
        // Tolerate a trailing slash so "<origin>/" + "/api/…" doesn't double up.
        return configured.hasSuffix("/") ? String(configured.dropLast()) : configured
    }

    /// Build a URL on the configured broker, e.g. `/api/oauth/webflow/start`.
    static func endpointURL(_ path: String) -> URL? {
        URL(string: baseURLString + path)
    }

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
              let code = components.queryItems?.first(where: { $0.name == "code" })?.value,
              !code.isEmpty else {
            show("Connection failed", "The OAuth callback was missing required details.")
            return
        }

        switch provider {
        case "shopify":
            guard let shop = components.queryItems?.first(where: { $0.name == "shop" })?.value,
                  !shop.isEmpty else {
                show("Shopify connection failed", "The OAuth callback was missing the shop.")
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
        case "webflow":
            // Webflow's token grants access to the user's authorized sites but
            // carries no siteId — exchange it, then hand the (long-lived) token
            // to the connect form where the user picks the site + collections.
            Task {
                do {
                    let token = try await exchangeWebflowCode(code)
                    NotificationCenter.default.post(
                        name: .specterWebflowOAuth,
                        object: nil,
                        userInfo: ["token": token.accessToken]
                    )
                } catch {
                    show("Webflow connection failed", error.localizedDescription)
                }
            }
        default:
            show("Connection failed", "Unknown OAuth provider: \(provider).")
        }
    }

    private func exchangeWebflowCode(_ code: String) async throws -> WebflowExchangeResponse {
        guard let endpoint = Self.endpointURL("/api/oauth/webflow/exchange") else {
            throw OAuthError.invalidResponse
        }
        var request = URLRequest(url: endpoint)
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
        return try JSONDecoder().decode(WebflowExchangeResponse.self, from: data)
    }

    private func exchangeShopifyCode(_ code: String) async throws -> ShopifyExchangeResponse {
        guard let endpoint = Self.endpointURL("/api/oauth/shopify/exchange") else {
            throw OAuthError.invalidResponse
        }
        var request = URLRequest(url: endpoint)
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

struct WebflowExchangeResponse: Decodable {
    let provider: String
    let accessToken: String
    let scope: String?
}

struct OAuthAPIError: Decodable {
    let error: String
}

extension Notification.Name {
    /// Posted after a Webflow OAuth token exchange succeeds. `userInfo["token"]`
    /// holds the access token; the App opens the connect form pre-filled with it.
    static let specterWebflowOAuth = Notification.Name("SpecterWebflowOAuth")
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
