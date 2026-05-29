import Foundation

/// Daemon config persisted at ~/.config/ghost-sync/config.json. Mirrors the
/// shape defined in src/config.ts so the daemon and GUI can co-edit the same
/// file. Optional fields default to the daemon's DEFAULT_SETTINGS values.
///
/// v0.4.0: gained `targets[]`. The Mac UI is still single-target (single
/// Ghost connection), so it edits the legacy flat fields; `ConfigStore.save`
/// regenerates `targets[0]` from those fields on write so the daemon sees a
/// consistent picture. Multi-target configs (rare today — hand-edited only)
/// are preserved round-trip: extras are written back untouched.
struct DaemonConfig: Codable {
    var ghostUrl: String = ""
    var adminApiKey: String = ""
    var vaultPath: String = ""
    var syncFolderPath: String = ""
    var pullDrafts: Bool = true
    var pullPublished: Bool = true
    var conflictStrategy: String = "ask"
    /// "auto" (push on edit) or "manual" (watcher only pulls; user drives pushes).
    var syncMode: String = "auto"
    var watchDebounceMs: Int = 2000
    /// Multi-target list. Optional in JSON for back-compat with v0.3.x configs.
    /// Always written by `ConfigStore.save` after v0.4.0.
    var targets: [TargetConfig]? = nil

    init() {}

    /// Custom decoder so configs written before a new field was added still
    /// load. Each `decodeIfPresent` falls back to the memberwise default —
    /// future field additions become zero-migration.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ghostUrl = try c.decodeIfPresent(String.self, forKey: .ghostUrl) ?? ""
        adminApiKey = try c.decodeIfPresent(String.self, forKey: .adminApiKey) ?? ""
        vaultPath = try c.decodeIfPresent(String.self, forKey: .vaultPath) ?? ""
        syncFolderPath = try c.decodeIfPresent(String.self, forKey: .syncFolderPath) ?? ""
        pullDrafts = try c.decodeIfPresent(Bool.self, forKey: .pullDrafts) ?? true
        pullPublished = try c.decodeIfPresent(Bool.self, forKey: .pullPublished) ?? true
        conflictStrategy = try c.decodeIfPresent(String.self, forKey: .conflictStrategy) ?? "ask"
        syncMode = try c.decodeIfPresent(String.self, forKey: .syncMode) ?? "auto"
        watchDebounceMs = try c.decodeIfPresent(Int.self, forKey: .watchDebounceMs) ?? 2000
        targets = try c.decodeIfPresent([TargetConfig].self, forKey: .targets)

        // If targets is present and the first one is a Ghost target, project
        // it back onto the legacy fields so the UI shows the right values
        // even if the user has never re-saved the config since v0.4.0.
        if let first = targets?.first, case .ghost(let g) = first.adapter {
            if ghostUrl.isEmpty { ghostUrl = g.ghostUrl }
            if adminApiKey.isEmpty { adminApiKey = g.adminApiKey }
            if syncFolderPath.isEmpty { syncFolderPath = first.syncFolderPath }
        }
    }
}

/// Per-target configuration — one CMS connection plus the engine-visible
/// sync settings. Mirrors TS `TargetConfig` in src/config.ts.
struct TargetConfig: Codable, Equatable {
    var handle: String
    var label: String
    var syncFolderPath: String
    var pullDrafts: Bool
    var pullPublished: Bool
    var conflictStrategy: String
    var syncMode: String
    var adapter: AdapterConfig
}

/// CMS adapter configuration. Discriminated by `platform`. Mirrors TS
/// `AdapterConfig` in src/cms/types.ts — all credential fields live as
/// siblings of `platform` (not nested), so the codec lists every possible
/// key explicitly rather than delegating to per-case structs.
enum AdapterConfig: Codable, Equatable {
    case ghost(GhostAdapter)
    case shopify(ShopifyAdapter)
    case wordpress(WordPressAdapter)

    struct GhostAdapter: Equatable {
        var ghostUrl: String
        var adminApiKey: String
    }

    struct ShopifyAdapter: Equatable {
        var shop: String
        var accessToken: String
        var refreshToken: String?
        var accessTokenExpiresAt: String?
        var refreshTokenExpiresAt: String?
        var apiVersion: String?
    }

    struct WordPressAdapter: Equatable {
        var siteUrl: String
        var username: String
        var appPassword: String
    }

    private enum CodingKeys: String, CodingKey {
        case platform, ghostUrl, adminApiKey, shop, accessToken, refreshToken
        case accessTokenExpiresAt, refreshTokenExpiresAt, apiVersion
        case siteUrl, username, appPassword
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let platform = try c.decode(String.self, forKey: .platform)
        switch platform {
        case "ghost":
            self = .ghost(.init(
                ghostUrl: try c.decode(String.self, forKey: .ghostUrl),
                adminApiKey: try c.decode(String.self, forKey: .adminApiKey)
            ))
        case "shopify":
            self = .shopify(.init(
                shop: try c.decode(String.self, forKey: .shop),
                accessToken: try c.decode(String.self, forKey: .accessToken),
                refreshToken: try c.decodeIfPresent(String.self, forKey: .refreshToken),
                accessTokenExpiresAt: try c.decodeIfPresent(String.self, forKey: .accessTokenExpiresAt),
                refreshTokenExpiresAt: try c.decodeIfPresent(String.self, forKey: .refreshTokenExpiresAt),
                apiVersion: try c.decodeIfPresent(String.self, forKey: .apiVersion)
            ))
        case "wordpress":
            self = .wordpress(.init(
                siteUrl: try c.decode(String.self, forKey: .siteUrl),
                username: try c.decode(String.self, forKey: .username),
                appPassword: try c.decode(String.self, forKey: .appPassword)
            ))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .platform,
                in: c,
                debugDescription: "Unknown CMS platform: \(platform)"
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .ghost(let g):
            try c.encode("ghost", forKey: .platform)
            try c.encode(g.ghostUrl, forKey: .ghostUrl)
            try c.encode(g.adminApiKey, forKey: .adminApiKey)
        case .shopify(let s):
            try c.encode("shopify", forKey: .platform)
            try c.encode(s.shop, forKey: .shop)
            try c.encode(s.accessToken, forKey: .accessToken)
            try c.encodeIfPresent(s.refreshToken, forKey: .refreshToken)
            try c.encodeIfPresent(s.accessTokenExpiresAt, forKey: .accessTokenExpiresAt)
            try c.encodeIfPresent(s.refreshTokenExpiresAt, forKey: .refreshTokenExpiresAt)
            try c.encodeIfPresent(s.apiVersion, forKey: .apiVersion)
        case .wordpress(let w):
            try c.encode("wordpress", forKey: .platform)
            try c.encode(w.siteUrl, forKey: .siteUrl)
            try c.encode(w.username, forKey: .username)
            try c.encode(w.appPassword, forKey: .appPassword)
        }
    }
}

enum ConfigStore {
    /// Returns the current config, or nil if no file exists yet (first launch).
    static func load() -> DaemonConfig? {
        guard let data = try? Data(contentsOf: Paths.configPath) else { return nil }
        return try? JSONDecoder().decode(DaemonConfig.self, from: data)
    }

    static func save(_ config: DaemonConfig) throws {
        let dir = Paths.configPath.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        // Regenerate targets[] from the legacy fields IF there's no existing
        // multi-target config to preserve. Single-target users get a clean
        // round-trip; hand-edited multi-target configs keep their extras.
        var toWrite = config
        toWrite.targets = mergeTargets(existing: config.targets, legacy: config)

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(toWrite)
        try data.write(to: Paths.configPath, options: .atomic)
        // Same 0600 mode the CLI uses — config contains the API key.
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: Paths.configPath.path
        )
    }

    static func upsertWordPressTarget(
        siteUrl: String,
        username: String,
        appPassword: String
    ) throws {
        guard var config = load(), !config.vaultPath.isEmpty else {
            throw ConfigError.missingBaseConfig
        }

        let normalized = normalizeWordPressSiteUrl(siteUrl)
        let host = hostnameFromUrl(normalized).isEmpty ? "site" : hostnameFromUrl(normalized)
        let slug = host
            .replacingOccurrences(of: ".", with: "-")
            .replacingOccurrences(of: "_", with: "-")
            .lowercased()
        let handle = "wordpress-\(slug)"

        let target = TargetConfig(
            handle: handle,
            label: "WordPress",
            syncFolderPath: handle,
            pullDrafts: config.pullDrafts,
            pullPublished: config.pullPublished,
            conflictStrategy: config.conflictStrategy,
            syncMode: config.syncMode,
            adapter: .wordpress(.init(
                siteUrl: normalized,
                username: username,
                appPassword: appPassword
            ))
        )

        var targets = config.targets ?? []
        if let idx = targets.firstIndex(where: {
            if case .wordpress(let w) = $0.adapter {
                return hostnameFromUrl(w.siteUrl) == host
            }
            return false
        }) {
            targets[idx] = target
        } else {
            targets.append(target)
        }
        config.targets = targets
        try save(config)
    }

    private static func normalizeWordPressSiteUrl(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if !s.contains("://") { s = "https://" + s }
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }

    private static func hostnameFromUrl(_ raw: String) -> String {
        guard let url = URL(string: raw), let host = url.host else {
            return raw
        }
        return host.lowercased()
    }

    static func upsertShopifyTarget(
        shop: String,
        accessToken: String,
        refreshToken: String? = nil,
        accessTokenExpiresAt: String? = nil,
        refreshTokenExpiresAt: String? = nil,
        scope: String? = nil
    ) throws {
        guard var config = load(), !config.vaultPath.isEmpty else {
            throw ConfigError.missingBaseConfig
        }

        let handle = shop
            .replacingOccurrences(of: ".myshopify.com", with: "")
            .replacingOccurrences(of: ".", with: "-")
            .replacingOccurrences(of: "_", with: "-")
            .lowercased()

        let target = TargetConfig(
            handle: "shopify-\(handle)",
            label: "Shopify",
            syncFolderPath: "shopify",
            pullDrafts: config.pullDrafts,
            pullPublished: config.pullPublished,
            conflictStrategy: config.conflictStrategy,
            syncMode: config.syncMode,
            adapter: .shopify(.init(
                shop: shop,
                accessToken: accessToken,
                refreshToken: refreshToken,
                accessTokenExpiresAt: accessTokenExpiresAt,
                refreshTokenExpiresAt: refreshTokenExpiresAt,
                apiVersion: nil
            ))
        )

        var targets = config.targets ?? []
        if let idx = targets.firstIndex(where: {
            if case .shopify(let s) = $0.adapter { return s.shop == shop }
            return false
        }) {
            targets[idx] = target
        } else {
            targets.append(target)
        }
        config.targets = targets
        try save(config)
    }

    /// Single-target case (or no existing targets): regenerate targets[0]
    /// from the legacy fields so the daemon picks up UI changes.
    /// Multi-target case: replace only the first Ghost target's URL/key from
    /// the legacy fields; leave targets[1..N] untouched.
    private static func mergeTargets(
        existing: [TargetConfig]?,
        legacy: DaemonConfig
    ) -> [TargetConfig] {
        let synthesized = TargetConfig(
            handle: "ghost",
            label: "Ghost",
            syncFolderPath: legacy.syncFolderPath,
            pullDrafts: legacy.pullDrafts,
            pullPublished: legacy.pullPublished,
            conflictStrategy: legacy.conflictStrategy,
            syncMode: legacy.syncMode,
            adapter: .ghost(.init(
                ghostUrl: legacy.ghostUrl,
                adminApiKey: legacy.adminApiKey
            ))
        )
        guard var existing = existing, !existing.isEmpty else {
            return [synthesized]
        }
        if let ghostIdx = existing.firstIndex(where: {
            if case .ghost = $0.adapter { return true }
            return false
        }) {
            existing[ghostIdx] = synthesized
            return existing
        }
        return [synthesized] + existing
    }

    static var exists: Bool {
        FileManager.default.fileExists(atPath: Paths.configPath.path)
    }

    /// Persist a per-target `syncMode` change ("auto" or "manual") from the
    /// Dashboard auto-sync toggle. Atomic on-disk (Foundation `.atomic` =
    /// tempfile + rename), chmod 600 reapplied — matches the contract every
    /// other config save in this file uses, so the daemon never reads a
    /// half-written file while the user is flipping toggles.
    ///
    /// Behavior:
    ///   - Loads the current config.
    ///   - If a target with the given handle exists, updates its `syncMode`.
    ///   - When the target is the synthesized Ghost target (handle "ghost"),
    ///     also mirrors the change onto the legacy top-level `syncMode` so
    ///     a downgrade to v0.3.x keeps working.
    ///   - Writes back via `save(...)`, which re-runs the `mergeTargets`
    ///     contract so non-Ghost targets in `targets[1..N]` survive.
    /// Returns `false` if the config is missing or the handle is unknown.
    @discardableResult
    static func setSyncMode(handle: String, mode: String) throws -> Bool {
        guard var config = load() else { return false }
        guard var targets = config.targets, !targets.isEmpty else { return false }
        guard let idx = targets.firstIndex(where: { $0.handle == handle }) else {
            return false
        }
        targets[idx].syncMode = mode

        // Keep the legacy mirror in sync when the user is toggling the
        // synthesized Ghost target. `save(...)` will regenerate `targets[0]`
        // from the legacy fields, so we have to update the legacy field too
        // — otherwise the merge would clobber our `syncMode` change.
        if case .ghost = targets[idx].adapter {
            config.syncMode = mode
        }
        config.targets = targets
        try save(config)
        return true
    }
}

enum ConfigError: LocalizedError {
    case missingBaseConfig

    var errorDescription: String? {
        switch self {
        case .missingBaseConfig:
            return "Set up a local sync folder before adding a new site."
        }
    }
}
