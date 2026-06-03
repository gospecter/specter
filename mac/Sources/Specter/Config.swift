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
    /// Origin of the OAuth broker used for hosted OAuth flows (Shopify, Webflow).
    /// Optional: nil → fall back to the hosted default (`https://spectersync.com`).
    /// PRO leaves it nil; DIY users who self-host a broker set it to their origin.
    /// See `OAuthController.baseURLString`.
    var oauthBaseUrl: String? = nil
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
        oauthBaseUrl = try c.decodeIfPresent(String.self, forKey: .oauthBaseUrl)
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

/// Content kinds a platform can sync, and the per-platform availability /
/// base-kind conventions. Mirrors `PLATFORM_KINDS` / `basePostKind` in
/// src/config.ts EXACTLY — the daemon is the source of truth and the Mac UI
/// must offer the same kinds in the same order, or it would let users tick a
/// kind the daemon will silently drop (and the legacy-migration default must
/// match so a re-save doesn't change what a legacy target syncs).
enum ContentKinds {
    /// Available kinds per platform, in the order the UI should offer them.
    /// First entry is the base post kind (the legacy-migration default).
    static func available(for platform: Platform) -> [String] {
        switch platform {
        case .ghost:     return ["post", "page"]
        case .wordpress: return ["post", "page"]
        case .shopify:   return ["article", "page", "product"]
        // Webflow kinds are dynamic (one `webflow:<collectionSlug>` per CMS
        // collection, enumerated live at connect time). `["post"]` is only the
        // legacy-migration base.
        case .webflow:   return ["post"]
        }
    }

    /// What a legacy target (no explicit `contentKinds`) migrates to so
    /// existing post sync keeps working. = first entry of `available`.
    static func basePostKind(for platform: Platform) -> String {
        available(for: platform).first ?? "post"
    }

    /// Whether a kind is valid for a platform. Webflow accepts any `webflow:`
    /// prefixed kind (its real set is the live site's collections); fixed-kind
    /// platforms match the static table. Mirrors `isContentKindAllowed` in
    /// src/config.ts — without it dynamic kinds get filtered out on load and the
    /// target silently syncs nothing.
    static func isAllowed(_ kind: String, for platform: Platform) -> Bool {
        if available(for: platform).contains(kind) { return true }
        if platform == .webflow { return kind.hasPrefix("webflow:") }
        return false
    }

    /// Human label for a kind in list/summary copy (pluralized).
    static func pluralLabel(_ kind: String) -> String {
        switch kind {
        case "post":    return "posts"
        case "page":    return "pages"
        case "article": return "articles"
        case "product": return "products"
        default:        return kind + "s"
        }
    }

    /// "Syncs: posts, pages" / "Syncs: nothing" for the Settings list + cards.
    static func summary(_ kinds: [String]) -> String {
        guard !kinds.isEmpty else { return "Syncs: nothing" }
        return "Syncs: " + kinds.map(pluralLabel).joined(separator: ", ")
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
    /// Which content kinds sync in BOTH directions for this target. Opt-in:
    /// empty array = "sync nothing". Mirrors TS `TargetConfig.contentKinds`.
    var contentKinds: [String]
    var adapter: AdapterConfig

    private enum CodingKeys: String, CodingKey {
        case handle, label, syncFolderPath, pullDrafts, pullPublished
        case conflictStrategy, syncMode, contentKinds, adapter
    }

    init(
        handle: String,
        label: String,
        syncFolderPath: String,
        pullDrafts: Bool,
        pullPublished: Bool,
        conflictStrategy: String,
        syncMode: String,
        contentKinds: [String],
        adapter: AdapterConfig
    ) {
        self.handle = handle
        self.label = label
        self.syncFolderPath = syncFolderPath
        self.pullDrafts = pullDrafts
        self.pullPublished = pullPublished
        self.conflictStrategy = conflictStrategy
        self.syncMode = syncMode
        self.contentKinds = contentKinds
        self.adapter = adapter
    }

    /// Custom decoder so legacy configs written before `contentKinds` existed
    /// still load: when the key is absent we MIGRATE to the platform's base
    /// post kind (matching the daemon's `normalizeContentKinds`), so a
    /// pre-existing target keeps syncing posts and the UI shows the migrated
    /// value. Present values (incl. `[]`) are filtered to kinds the platform
    /// actually supports — same as the daemon.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        handle = try c.decode(String.self, forKey: .handle)
        label = try c.decode(String.self, forKey: .label)
        syncFolderPath = try c.decode(String.self, forKey: .syncFolderPath)
        pullDrafts = try c.decode(Bool.self, forKey: .pullDrafts)
        pullPublished = try c.decode(Bool.self, forKey: .pullPublished)
        conflictStrategy = try c.decode(String.self, forKey: .conflictStrategy)
        syncMode = try c.decode(String.self, forKey: .syncMode)
        adapter = try c.decode(AdapterConfig.self, forKey: .adapter)

        let platform = adapter.platform
        if let raw = try c.decodeIfPresent([String].self, forKey: .contentKinds) {
            contentKinds = raw.filter { ContentKinds.isAllowed($0, for: platform) }
        } else {
            // Legacy target: migrate to the base post kind.
            contentKinds = [ContentKinds.basePostKind(for: platform)]
        }
    }
}

/// CMS adapter configuration. Discriminated by `platform`. Mirrors TS
/// `AdapterConfig` in src/cms/types.ts — all credential fields live as
/// siblings of `platform` (not nested), so the codec lists every possible
/// key explicitly rather than delegating to per-case structs.
enum AdapterConfig: Codable, Equatable {
    case ghost(GhostAdapter)
    case shopify(ShopifyAdapter)
    case wordpress(WordPressAdapter)
    case webflow(WebflowAdapter)

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

    struct WebflowAdapter: Equatable {
        var siteId: String
        /// Pasted Site API token (DIY). Optional because an OAuth target may
        /// carry only `accessToken`.
        var apiToken: String?
        /// OAuth access token (PRO). Webflow tokens are long-lived / non-expiring
        /// with no refresh token, so this is just another bearer token.
        var accessToken: String?
    }

    /// The `Platform` this adapter belongs to — used to resolve available
    /// content kinds and the legacy-migration base kind.
    var platform: Platform {
        switch self {
        case .ghost:     return .ghost
        case .shopify:   return .shopify
        case .wordpress: return .wordpress
        case .webflow:   return .webflow
        }
    }

    private enum CodingKeys: String, CodingKey {
        case platform, ghostUrl, adminApiKey, shop, accessToken, refreshToken
        case accessTokenExpiresAt, refreshTokenExpiresAt, apiVersion
        case siteUrl, username, appPassword
        case siteId, apiToken
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
        case "webflow":
            self = .webflow(.init(
                siteId: try c.decode(String.self, forKey: .siteId),
                apiToken: try c.decodeIfPresent(String.self, forKey: .apiToken),
                accessToken: try c.decodeIfPresent(String.self, forKey: .accessToken)
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
        case .webflow(let wf):
            try c.encode("webflow", forKey: .platform)
            try c.encode(wf.siteId, forKey: .siteId)
            try c.encodeIfPresent(wf.apiToken, forKey: .apiToken)
            try c.encodeIfPresent(wf.accessToken, forKey: .accessToken)
        }
    }
}

/// Handle conventions mirrored from `src/config.ts` (`slugifyHandle` +
/// `ensureUniqueHandle`). The daemon's `saveConfig` validates targets against
/// `HANDLE_RE` and rejects collisions, so the Swift side must produce handles
/// that satisfy the exact same rules or saves the daemon would reject.
enum TargetHandle {
    /// `^[a-z0-9][a-z0-9-]*$` — lowercase letters, digits, hyphens; path-safe.
    /// Strips URL scheme, lowercases, collapses runs of non-[a-z0-9] to a single
    /// hyphen, trims leading/trailing hyphens. Falls back to "target".
    static func slugify(_ input: String) -> String {
        // Drop any leading scheme (https://, etc.).
        var s = input
        if let r = s.range(of: "://") {
            s = String(s[r.upperBound...])
        }
        s = s.lowercased()
        // Collapse every run of non-[a-z0-9] into a single hyphen.
        var out = ""
        var lastWasHyphen = false
        for ch in s {
            if ch.isLowercaseASCIILetterOrDigit {
                out.append(ch)
                lastWasHyphen = false
            } else if !lastWasHyphen {
                out.append("-")
                lastWasHyphen = true
            }
        }
        while out.hasPrefix("-") { out.removeFirst() }
        while out.hasSuffix("-") { out.removeLast() }
        return out.isEmpty ? "target" : out
    }

    /// Return a slug of `base` that doesn't collide with `taken`, appending
    /// `-2`, `-3`, … until unique.
    static func unique(base: String, taken: [String]) -> String {
        let set = Set(taken)
        let root = slugify(base)
        if !set.contains(root) { return root }
        var n = 2
        while set.contains("\(root)-\(n)") { n += 1 }
        return "\(root)-\(n)"
    }
}

private extension Character {
    var isLowercaseASCIILetterOrDigit: Bool {
        ("a"..."z").contains(self) || ("0"..."9").contains(self)
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

        // Preserve targets[] verbatim when present (never drop or re-handle a
        // target); only synthesize a single Ghost target from the legacy flat
        // fields on first run when no targets exist yet. See `mergeTargets`.
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
        appPassword: String,
        contentKinds: [String],
        label: String? = nil,
        editingHandle: String? = nil
    ) throws {
        guard var config = load(), !config.vaultPath.isEmpty else {
            throw ConfigError.missingBaseConfig
        }

        let normalized = normalizeWordPressSiteUrl(siteUrl)
        let host = hostnameFromUrl(normalized).isEmpty ? "site" : hostnameFromUrl(normalized)
        let resolvedLabel = (label?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap {
            $0.isEmpty ? nil : $0
        } ?? "WordPress"
        let adapter: AdapterConfig = .wordpress(.init(
            siteUrl: normalized,
            username: username,
            appPassword: appPassword
        ))

        var targets = config.targets ?? []
        // Reuse the row identified by editingHandle (Edit flow) or an existing
        // WordPress target pointing at the same host; otherwise append a new one
        // with a fresh unique, slugified handle and its own folder (empty
        // syncFolderPath → daemon uses `<handle>/`).
        let existingIdx = targets.firstIndex(where: {
            if let editingHandle { return $0.handle == editingHandle }
            if case .wordpress(let w) = $0.adapter {
                return hostnameFromUrl(w.siteUrl) == host
            }
            return false
        })

        if let idx = existingIdx {
            targets[idx].label = resolvedLabel
            targets[idx].adapter = adapter
            targets[idx].contentKinds = contentKinds
        } else {
            let taken = targets.map { $0.handle }
            let handle = TargetHandle.unique(base: host, taken: taken)
            targets.append(TargetConfig(
                handle: handle,
                label: resolvedLabel,
                syncFolderPath: "",
                pullDrafts: config.pullDrafts,
                pullPublished: config.pullPublished,
                conflictStrategy: config.conflictStrategy,
                syncMode: config.syncMode,
                contentKinds: contentKinds,
                adapter: adapter
            ))
        }
        config.targets = targets
        try save(config)
    }

    /// Add or update a Webflow target. `apiToken` (DIY) or `accessToken` (PRO
    /// OAuth) carries the bearer token — at least one is required. Duplicate
    /// detection (and the per-target folder) keys on `siteId`. Editing preserves
    /// the prior token when the caller omits it.
    static func upsertWebflowTarget(
        siteId: String,
        apiToken: String?,
        accessToken: String?,
        contentKinds: [String],
        label: String? = nil,
        editingHandle: String? = nil
    ) throws {
        guard var config = load(), !config.vaultPath.isEmpty else {
            throw ConfigError.missingBaseConfig
        }
        let trimmedSite = siteId.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedLabel = (label?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap {
            $0.isEmpty ? nil : $0
        } ?? "Webflow"

        var targets = config.targets ?? []
        let existingIdx = targets.firstIndex(where: {
            if let editingHandle { return $0.handle == editingHandle }
            if case .webflow(let wf) = $0.adapter { return wf.siteId == trimmedSite }
            return false
        })

        // Preserve a prior token when editing and the caller omitted it.
        var priorApiToken: String?
        var priorAccessToken: String?
        if let idx = existingIdx, case .webflow(let wf) = targets[idx].adapter {
            priorApiToken = wf.apiToken
            priorAccessToken = wf.accessToken
        }
        let adapter: AdapterConfig = .webflow(.init(
            siteId: trimmedSite,
            apiToken: apiToken ?? priorApiToken,
            accessToken: accessToken ?? priorAccessToken
        ))

        if let idx = existingIdx {
            targets[idx].label = resolvedLabel
            targets[idx].adapter = adapter
            targets[idx].contentKinds = contentKinds
        } else {
            let taken = targets.map { $0.handle }
            let handle = TargetHandle.unique(base: "webflow-\(trimmedSite)", taken: taken)
            targets.append(TargetConfig(
                handle: handle,
                label: resolvedLabel,
                syncFolderPath: "",
                pullDrafts: config.pullDrafts,
                pullPublished: config.pullPublished,
                conflictStrategy: config.conflictStrategy,
                syncMode: config.syncMode,
                contentKinds: contentKinds,
                adapter: adapter
            ))
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

    /// `contentKinds`:
    ///   - nil (the OAuth completion path — there's no form to pick at
    ///     creation) → a NEW store is created with the base kind `["article"]`
    ///     so existing post-style sync works out of the box; an EXISTING store
    ///     being re-authorized keeps whatever kinds the user already chose.
    ///   - non-nil (the per-card Edit path) → written verbatim for both new and
    ///     existing rows.
    static func upsertShopifyTarget(
        shop: String,
        accessToken: String,
        refreshToken: String? = nil,
        accessTokenExpiresAt: String? = nil,
        refreshTokenExpiresAt: String? = nil,
        scope: String? = nil,
        contentKinds: [String]? = nil,
        editingHandle: String? = nil
    ) throws {
        guard var config = load(), !config.vaultPath.isEmpty else {
            throw ConfigError.missingBaseConfig
        }

        let adapter: AdapterConfig = .shopify(.init(
            shop: shop,
            accessToken: accessToken,
            refreshToken: refreshToken,
            accessTokenExpiresAt: accessTokenExpiresAt,
            refreshTokenExpiresAt: refreshTokenExpiresAt,
            apiVersion: nil
        ))

        var targets = config.targets ?? []
        if let idx = targets.firstIndex(where: {
            if let editingHandle { return $0.handle == editingHandle }
            if case .shopify(let s) = $0.adapter { return s.shop == shop }
            return false
        }) {
            // Same store re-authorized (or edited): refresh credentials, keep
            // handle/folder. Only overwrite contentKinds when the caller passed
            // an explicit list (Edit) — OAuth re-auth (nil) preserves the
            // user's prior choices.
            targets[idx].adapter = adapter
            if let contentKinds { targets[idx].contentKinds = contentKinds }
        } else {
            // New store: unique slugified handle from the shop domain, and an
            // empty syncFolderPath so the daemon gives it its own `<handle>/`
            // folder. A hardcoded shared folder would collide with a second store.
            // No creation form for Shopify, so default to the base kind.
            let taken = targets.map { $0.handle }
            let handle = TargetHandle.unique(base: shop, taken: taken)
            targets.append(TargetConfig(
                handle: handle,
                label: "Shopify",
                syncFolderPath: "",
                pullDrafts: config.pullDrafts,
                pullPublished: config.pullPublished,
                conflictStrategy: config.conflictStrategy,
                syncMode: config.syncMode,
                contentKinds: contentKinds ?? [ContentKinds.basePostKind(for: .shopify)],
                adapter: adapter
            ))
        }
        config.targets = targets
        try save(config)
    }

    /// Append (or update) a Ghost blog target. Mirrors the Shopify/WordPress
    /// upserts so a second, third, … Ghost blog can be added without
    /// overwriting the first — each gets a unique slugified handle derived from
    /// its host (falling back to the label) and an empty `syncFolderPath` so the
    /// daemon isolates it under its own `<handle>/` folder.
    ///
    /// `editingHandle`, when set, targets an existing row for in-place edit
    /// (URL/key/label change) without minting a new handle.
    static func upsertGhostTarget(
        ghostUrl: String,
        adminApiKey: String,
        contentKinds: [String],
        label: String? = nil,
        editingHandle: String? = nil
    ) throws {
        guard var config = load(), !config.vaultPath.isEmpty else {
            throw ConfigError.missingBaseConfig
        }

        let normalized = normalizeGhostUrl(ghostUrl)
        let host = hostnameFromUrl(normalized).isEmpty ? "ghost" : hostnameFromUrl(normalized)
        let resolvedLabel = (label?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap {
            $0.isEmpty ? nil : $0
        } ?? "Ghost"
        let adapter: AdapterConfig = .ghost(.init(
            ghostUrl: normalized,
            adminApiKey: adminApiKey
        ))

        var targets = config.targets ?? []
        let existingIdx = targets.firstIndex(where: {
            if let editingHandle { return $0.handle == editingHandle }
            if case .ghost(let g) = $0.adapter {
                return hostnameFromUrl(g.ghostUrl) == host
            }
            return false
        })

        if let idx = existingIdx {
            targets[idx].label = resolvedLabel
            targets[idx].adapter = adapter
            targets[idx].contentKinds = contentKinds
        } else {
            let base = host == "ghost" ? resolvedLabel : host
            let taken = targets.map { $0.handle }
            let handle = TargetHandle.unique(base: base, taken: taken)
            targets.append(TargetConfig(
                handle: handle,
                label: resolvedLabel,
                syncFolderPath: "",
                pullDrafts: config.pullDrafts,
                pullPublished: config.pullPublished,
                conflictStrategy: config.conflictStrategy,
                syncMode: config.syncMode,
                contentKinds: contentKinds,
                adapter: adapter
            ))
        }

        // Keep the legacy flat fields aligned with targets[0] for downgrade
        // compatibility (save() also derives them, but only when targets[0] is
        // Ghost — do it here too so a first Ghost add sticks immediately).
        if let first = targets.first, case .ghost(let g) = first.adapter {
            config.ghostUrl = g.ghostUrl
            config.adminApiKey = g.adminApiKey
            config.syncFolderPath = first.syncFolderPath
        }

        config.targets = targets
        try save(config)
    }

    /// Remove the target with `handle` from `targets[]` and re-save. Vault
    /// files are left in place (the daemon never deletes folders on
    /// disconnect). Returns false if no config or no matching target.
    @discardableResult
    static func removeTarget(handle: String) throws -> Bool {
        guard var config = load() else { return false }
        guard var targets = config.targets,
              let idx = targets.firstIndex(where: { $0.handle == handle })
        else { return false }
        targets.remove(at: idx)
        config.targets = targets
        // If the removed target was a Ghost blog that legacy fields mirrored,
        // re-point the legacy mirror at whatever Ghost target remains (or clear
        // it). save()'s mergeTargets will not resurrect the removed row because
        // it now preserves targets[] verbatim for the non-empty case.
        if let firstGhost = targets.first(where: {
            if case .ghost = $0.adapter { return true }
            return false
        }), case .ghost(let g) = firstGhost.adapter {
            config.ghostUrl = g.ghostUrl
            config.adminApiKey = g.adminApiKey
            config.syncFolderPath = firstGhost.syncFolderPath
        } else {
            config.ghostUrl = ""
            config.adminApiKey = ""
        }
        try save(config)
        return true
    }

    private static func normalizeGhostUrl(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if !s.isEmpty && !s.contains("://") { s = "https://" + s }
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }

    /// Reconcile `targets[]` with the legacy flat fields on save.
    ///
    /// Multi-target safety (the whole point of this rewrite): when an explicit
    /// `targets[]` already exists it is preserved VERBATIM — no target is
    /// dropped, re-handled, or collapsed into a single "ghost" slot. We only
    /// fold the legacy flat fields back into `targets[0]` when that first
    /// target is a Ghost blog (the single-Ghost UI still edits the flat fields
    /// via onboarding/Settings); every other target — including a 2nd Ghost
    /// blog at `targets[1..N]` — is left exactly as the caller passed it.
    ///
    /// First-run only: when there are no targets yet but the legacy fields hold
    /// a Ghost connection, synthesize the single `ghost` target so the daemon
    /// has something to run. This keeps the original first-run behavior without
    /// ever clobbering an established multi-target config.
    private static func mergeTargets(
        existing: [TargetConfig]?,
        legacy: DaemonConfig
    ) -> [TargetConfig]? {
        if var existing = existing, !existing.isEmpty {
            // Fold the legacy flat fields back onto targets[0] ONLY in the
            // single-target Ghost case — that's the one configuration the
            // legacy onboarding/Settings editor owns (it edits the flat
            // ghostUrl/adminApiKey/syncFolderPath, not targets[]). In any
            // multi-target config the dedicated per-platform forms write
            // targets[] directly, and the legacy `syncFolderPath` mirror is
            // meaningless there (each target's folder is its handle), so we
            // preserve every target verbatim and never re-derive from the flat
            // fields — this is what stops a 2nd Ghost blog from being dropped.
            if existing.count == 1, case .ghost(let g) = existing[0].adapter {
                existing[0].adapter = .ghost(.init(
                    ghostUrl: legacy.ghostUrl.isEmpty ? g.ghostUrl : legacy.ghostUrl,
                    adminApiKey: legacy.adminApiKey.isEmpty ? g.adminApiKey : legacy.adminApiKey
                ))
                existing[0].syncFolderPath = legacy.syncFolderPath
                existing[0].pullDrafts = legacy.pullDrafts
                existing[0].pullPublished = legacy.pullPublished
                existing[0].conflictStrategy = legacy.conflictStrategy
                existing[0].syncMode = legacy.syncMode
            }
            return existing
        }

        // No targets yet. Only synthesize a first-run Ghost target when the
        // legacy fields actually describe a connection; otherwise leave nil so
        // we don't write an empty/placeholder target.
        guard !legacy.ghostUrl.isEmpty || !legacy.adminApiKey.isEmpty else {
            return nil
        }
        return [TargetConfig(
            handle: "ghost",
            label: "Ghost",
            syncFolderPath: legacy.syncFolderPath,
            pullDrafts: legacy.pullDrafts,
            pullPublished: legacy.pullPublished,
            conflictStrategy: legacy.conflictStrategy,
            syncMode: legacy.syncMode,
            // First-run onboarding has no kind picker — synthesize the base
            // post kind, matching the daemon's `synthesizeLegacyTarget`.
            contentKinds: [ContentKinds.basePostKind(for: .ghost)],
            adapter: .ghost(.init(
                ghostUrl: legacy.ghostUrl,
                adminApiKey: legacy.adminApiKey
            ))
        )]
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
