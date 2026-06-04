import SwiftUI

/// Spec: tasks/spec-multi-cms-ui.md — S3 Dashboard `SyncCard` component.
///
/// One card per connected target. Holds presentation only — actions are passed
/// in as closures so the Dashboard can wire them to the daemon.
///
/// NOTE: the grid layout was dropped in favor of a single labeled-table list
/// (see `SyncCardRow` / `ConnectionsTableHeader`). This card is no longer
/// rendered in the production UI; it's kept for its `#Preview` and as the
/// reference card design.

struct SyncTarget: Identifiable, Hashable {
    enum State: String { case idle, syncing, conflict, error, disconnected }

    let id: String
    var platform: Platform
    var siteUrl: String
    var state: State
    var lastSyncedRelative: String?       // "2 min ago"
    var summary: String                    // "12 posts · vault/blog"
    var autoSync: Bool
    var conflictCount: Int = 0
    /// User-facing label from `TargetConfig.label` (e.g. "Marketing blog").
    var label: String = ""
    /// Content kinds this target syncs (both directions). Drives the
    /// "Syncs: posts, pages" line. Empty = syncs nothing.
    var contentKinds: [String] = []
}

struct SyncCard: View {
    @Binding var target: SyncTarget
    /// True while a pull/push is in flight for this connection. Drives the
    /// inline spinner so a click produces immediate, in-window feedback rather
    /// than relying only on a system notification.
    var isRunning: Bool = false

    @State private var isHovered = false

    var onPull: () -> Void = {}
    var onPush: () -> Void = {}
    var onDryRun: () -> Void = {}
    var onEdit: () -> Void = {}
    var onTest: () -> Void = {}
    var onRemove: () -> Void = {}
    var onResolveConflict: () -> Void = {}
    /// Called when the user changes the sync mode. The Dashboard persists this
    /// to `config.targets[handle].syncMode` and restarts the daemon so the
    /// watcher picks up the new mode.
    var onAutoSyncChange: (Bool) -> Void = { _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Top row: platform icon tile ........ health pill
            HStack(alignment: .top) {
                PlatformIconTile(systemName: target.platformIcon, logoName: target.platformLogoName, size: 44)
                Spacer()
                DSPill(text: target.health.text, tone: target.health.tone, dot: true,
                       pulse: target.state == .syncing || isRunning)
            }

            // Title + label
            VStack(alignment: .leading, spacing: 2) {
                Text(target.displayName)
                    .font(DS.Typography.headlineMd())
                    .foregroundStyle(DS.Text.primary)
                    .lineLimit(1)
                Text(target.platform.displayName)
                    .font(DS.Typography.bodyMd())
                    .foregroundStyle(DS.Text.muted)
            }
            .padding(.top, 16)

            // Content-kind line — what this target actually syncs.
            Text(ContentKinds.summary(target.contentKinds))
                .font(DS.Typography.labelSm())
                .foregroundStyle(target.contentKinds.isEmpty ? DS.Status.warning : DS.Text.outline)
                .padding(.top, 6)

            // Divider
            Rectangle()
                .fill(DS.Surface.borderSubtle)
                .frame(height: 1)
                .padding(.vertical, 16)

            // Meta row: last sync (left) ........ sync-mode control (right)
            HStack(alignment: .center) {
                labelledMeta("LAST SYNC", target.lastSyncText)
                Spacer()
                VStack(alignment: .trailing, spacing: 4) {
                    Text("SYNC MODE")
                        .font(DS.Typography.labelSm())
                        .foregroundStyle(DS.Text.outline)
                    SyncModeControl(isAuto: Binding(
                        get: { target.autoSync },
                        set: { newValue in
                            target.autoSync = newValue
                            onAutoSyncChange(newValue)
                        }
                    ))
                }
            }

            // Action row — its own full-width line so the buttons never get
            // crushed / wrapped at narrow card widths (the old single-row
            // footer wrapped "Pull now" into "Pul / l / no / w").
            HStack(spacing: 8) {
                actions
            }
            .padding(.top, 16)
        }
        .dsCard(padding: 20)
        // Hover lift — accent border + subtle raise, matching the mock's
        // card hover. SF doesn't give this for free; SwiftUI animates it.
        .overlay(
            RoundedRectangle(cornerRadius: DS.Radius.lg)
                .strokeBorder(DS.Accent.primary.opacity(isHovered ? 0.5 : 0), lineWidth: 1)
        )
        .scaleEffect(isHovered ? 1.006 : 1.0)
        .animation(.easeOut(duration: 0.18), value: isHovered)
        .onHover { isHovered = $0 }
    }

    private func labelledMeta(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(DS.Typography.labelSm())
                .foregroundStyle(DS.Text.outline)
            Text(value)
                .font(DS.Typography.bodyMd())
                .foregroundStyle(DS.Text.primary)
        }
    }

    @ViewBuilder
    private var actions: some View {
        if target.state == .conflict {
            Button("Resolve conflict", action: onResolveConflict)
                .buttonStyle(DSGhostButtonStyle(tone: DS.Status.warning))
            Spacer()
            moreMenu
        } else {
            Button(action: onPull) {
                HStack(spacing: 6) {
                    if isRunning { ProgressView().controlSize(.small).scaleEffect(0.7) }
                    Text("Pull")
                }
            }
            .buttonStyle(DSGhostButtonStyle())
            .disabled(isRunning)

            Button("Push", action: onPush)
                .buttonStyle(DSGhostButtonStyle())
                .disabled(isRunning)
            Spacer()
            moreMenu
        }
    }

    /// Per-card overflow menu: Dry-run preview, Edit (reopen the platform
    /// connect form pre-filled, which includes content-kind selection), Test
    /// connection, and Disconnect (remove from config; vault files left in place).
    private var moreMenu: some View {
        Menu {
            Button("Dry-run preview…", action: onDryRun)
            Button("Edit…", action: onEdit)
            Button("Test connection", action: onTest)
            Divider()
            Button("Disconnect…", role: .destructive, action: onRemove)
        } label: {
            Image(systemName: "ellipsis")
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
    }

}

// MARK: - Shared display helpers

extension SyncTarget {
    /// Primary row title. Read as the *site* it points at — "myblog.ghost.io",
    /// not just "Ghost". A meaningful custom label wins, but a label that merely
    /// repeats the platform name ("Ghost") is treated as no label so the domain
    /// shows instead. Falls back to the platform name only when there's no URL.
    var displayName: String {
        let host = Self.bareHost(siteUrl)
        let labelIsPlatformName = label.caseInsensitiveCompare(platform.displayName) == .orderedSame
        if !label.isEmpty && !labelIsPlatformName { return label }
        return host.isEmpty ? platform.displayName : host
    }

    /// Strip scheme + leading `www.` + any path/query, leaving just the host.
    /// "https://www.example.com/blog" → "example.com".
    static func bareHost(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if let range = s.range(of: "://") { s = String(s[range.upperBound...]) }
        if let slash = s.firstIndex(of: "/") { s = String(s[..<slash]) }
        s = s.split(separator: "?").first.map(String.init) ?? s
        if s.lowercased().hasPrefix("www.") { s = String(s.dropFirst(4)) }
        return s
    }

    var subtitle: String {
        label.isEmpty ? siteUrl : label
    }

    var lastSyncText: String {
        switch state {
        case .disconnected: return "Not connected"
        default:            return lastSyncedRelative ?? "Never"
        }
    }

    /// Whether this connection has completed at least one sync. Used to tell
    /// "set up but never run" apart from a genuine OK/SYNCED state.
    var hasSynced: Bool { lastSyncedRelative != nil }

    /// SF Symbol fallback used when the bundled brand logo can't be loaded
    /// (e.g. the debug `swift build` binary, which has no app bundle).
    var platformIcon: String {
        switch platform {
        case .ghost:     return "doc.text"
        case .shopify:   return "bag"
        case .wordpress: return "globe"
        case .webflow:   return "square.grid.2x2"
        }
    }

    /// Bundled brand iconmark filename (Contents/Resources/Logos/<name>.png),
    /// matching the simple-icons slug. Rendered as a tinted template image.
    var platformLogoName: String {
        switch platform {
        case .ghost:     return "ghost"
        case .shopify:   return "shopify"
        case .wordpress: return "wordpress"
        case .webflow:   return "webflow"
        }
    }

    /// Connection **health** — the outcome of the last sync, using the same
    /// vocabulary as the Sync Logs STATUS column so the two screens agree.
    /// This is deliberately independent of the sync *mode* (Auto/Manual),
    /// which is shown by its own control. The old pill conflated the two
    /// ("PAUSED" really meant "manual mode", which read as broken).
    var health: (text: String, tone: DSPill.Tone) {
        switch state {
        case .error:        return ("ERROR", .error)
        case .conflict:
            return (conflictCount <= 1 ? "CONFLICT" : "\(conflictCount) CONFLICTS", .warning)
        case .syncing:      return ("SYNCING", .accent)
        case .disconnected: return ("NOT CONNECTED", .neutral)
        case .idle:         return hasSynced ? ("SYNCED", .success) : ("NEVER SYNCED", .neutral)
        }
    }
}

/// Platform glyph in a rounded tile, matching the mockup's icon chip.
/// Shared by the grid card and the compact list row.
struct PlatformIconTile: View {
    let systemName: String
    /// Bundled brand-logo filename (without extension). When present and the
    /// PNG is found in the app bundle, the real brand iconmark is shown instead
    /// of the SF Symbol fallback.
    var logoName: String? = nil
    var size: CGFloat = 44

    /// The bundled monochrome iconmark, loaded as a template so it tints to the
    /// UI. `nil` in the debug `swift build` binary (no app bundle) → SF fallback.
    private var brandLogo: NSImage? {
        guard let logoName,
              let url = Bundle.main.url(forResource: logoName, withExtension: "svg", subdirectory: "Logos"),
              let img = NSImage(contentsOf: url) else { return nil }
        img.isTemplate = true
        return img
    }

    var body: some View {
        RoundedRectangle(cornerRadius: DS.Radius.base)
            .fill(DS.Surface.base)
            .frame(width: size, height: size)
            .overlay(
                RoundedRectangle(cornerRadius: DS.Radius.base)
                    .strokeBorder(DS.Surface.borderSubtle, lineWidth: 1)
            )
            .overlay(glyph)
    }

    @ViewBuilder private var glyph: some View {
        if let logo = brandLogo {
            Image(nsImage: logo)
                .resizable()
                .renderingMode(.template)
                .scaledToFit()
                .frame(width: size * 0.52, height: size * 0.52)
                .foregroundStyle(DS.Text.primary)
        } else {
            Image(systemName: systemName)
                .font(.system(size: size * 0.4, weight: .medium))
                .foregroundStyle(DS.Accent.primary)
        }
    }
}

/// Shared column geometry for the Connections "list" layout, so the header
/// labels line up with each row's cells (the feedback: the list view had no
/// column labels, unlike the Sync Logs table — adopt that design here).
enum ConnectionsColumns {
    static let connection: CGFloat = 240
    static let status: CGFloat = 140
    static let mode: CGFloat = 150
    static let lastSync: CGFloat = 110
}

/// Header row for the Connections table layout. Mirrors `SyncLogHeader`.
struct ConnectionsTableHeader: View {
    var body: some View {
        HStack(spacing: DS.Space.gutter) {
            cell("CONNECTION", width: ConnectionsColumns.connection, align: .leading)
            cell("STATUS", width: ConnectionsColumns.status, align: .leading)
            cell("SYNC MODE", width: ConnectionsColumns.mode, align: .leading)
            cell("LAST SYNC", width: ConnectionsColumns.lastSync, align: .leading)
            cell("ACTIONS", width: nil, align: .trailing)
        }
        .padding(.horizontal, DS.Space.gutter)
        .padding(.vertical, DS.Space.gutter)
        .background(DS.Surface.panel)
        .overlay(Rectangle().fill(DS.Surface.borderSubtle).frame(height: 1), alignment: .bottom)
    }

    @ViewBuilder
    private func cell(_ text: String, width: CGFloat?, align: Alignment) -> some View {
        Text(text)
            .font(DS.Typography.labelSm())
            .foregroundStyle(DS.Text.outline)
            .frame(width: width, alignment: align)
            .frame(maxWidth: width == nil ? .infinity : nil, alignment: align)
    }
}

/// Column-aligned row variant of `SyncCard` for the Connections "list" layout.
/// Cells line up under `ConnectionsTableHeader`. Same data + closures.
struct SyncCardRow: View {
    @Binding var target: SyncTarget
    var isRunning: Bool = false

    var onPull: () -> Void = {}
    var onPush: () -> Void = {}
    var onDryRun: () -> Void = {}
    var onEdit: () -> Void = {}
    var onTest: () -> Void = {}
    var onRemove: () -> Void = {}
    var onResolveConflict: () -> Void = {}
    var onAutoSyncChange: (Bool) -> Void = { _ in }

    @State private var isHovered = false

    var body: some View {
        HStack(spacing: DS.Space.gutter) {
            // CONNECTION
            HStack(spacing: 10) {
                PlatformIconTile(systemName: target.platformIcon, logoName: target.platformLogoName, size: 32)
                VStack(alignment: .leading, spacing: 1) {
                    Text(target.displayName)
                        .font(DS.Typography.headlineSm())
                        .foregroundStyle(DS.Text.primary)
                        .lineLimit(1)
                    Text(target.platform.displayName)
                        .font(DS.Typography.bodySm())
                        .foregroundStyle(DS.Text.muted)
                        .lineLimit(1)
                }
            }
            .frame(width: ConnectionsColumns.connection, alignment: .leading)

            // STATUS
            DSPill(text: target.health.text, tone: target.health.tone, dot: true,
                   pulse: target.state == .syncing || isRunning)
                .frame(width: ConnectionsColumns.status, alignment: .leading)

            // SYNC MODE
            Group {
                if target.state == .conflict {
                    Text("—").foregroundStyle(DS.Text.outline)
                } else {
                    SyncModeControl(isAuto: Binding(
                        get: { target.autoSync },
                        set: { newValue in
                            target.autoSync = newValue
                            onAutoSyncChange(newValue)
                        }
                    ))
                }
            }
            .frame(width: ConnectionsColumns.mode, alignment: .leading)

            // LAST SYNC
            Text(target.lastSyncText)
                .font(DS.Typography.bodySm())
                .foregroundStyle(DS.Text.muted)
                .lineLimit(1)
                .frame(width: ConnectionsColumns.lastSync, alignment: .leading)

            // ACTIONS
            HStack(spacing: 6) {
                if target.state == .conflict {
                    Button("Resolve", action: onResolveConflict)
                        .buttonStyle(DSGhostButtonStyle(tone: DS.Status.warning))
                } else {
                    Button(action: onPull) {
                        HStack(spacing: 5) {
                            if isRunning { ProgressView().controlSize(.small).scaleEffect(0.6) }
                            Text("Pull")
                        }
                    }
                    .buttonStyle(DSGhostButtonStyle())
                    .disabled(isRunning)
                    Button("Push", action: onPush).buttonStyle(DSGhostButtonStyle()).disabled(isRunning)
                }
                rowMenu
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .padding(.horizontal, DS.Space.gutter)
        .padding(.vertical, 10)
        .background(isHovered ? DS.Surface.hover : Color.clear)
        .onHover { isHovered = $0 }
    }

    private var rowMenu: some View {
        Menu {
            Button("Dry-run preview…", action: onDryRun)
            Button("Edit…", action: onEdit)
            Button("Test connection", action: onTest)
            Divider()
            Button("Disconnect…", role: .destructive, action: onRemove)
        } label: {
            Image(systemName: "ellipsis")
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
    }
}

/// Two-segment Manual / Auto control. Both modes are named explicitly and
/// carry equal visual weight — "Manual" is a deliberate choice, not the
/// absence of "Auto". (Old design was a single "Auto" switch whose off-state
/// read as "auto is broken".) The active segment fills with the accent color.
struct SyncModeControl: View {
    @Binding var isAuto: Bool

    var body: some View {
        HStack(spacing: 0) {
            segment("Manual", active: !isAuto) { if isAuto { isAuto = false } }
            segment("Auto",   active:  isAuto) { if !isAuto { isAuto = true } }
        }
        .background(DS.Surface.input, in: Capsule())
        .overlay(Capsule().strokeBorder(DS.Surface.borderSubtle, lineWidth: 1))
        .help(isAuto
              ? "Auto — Specter watches this folder and syncs on every change."
              : "Manual — syncs only when you click Pull or Push (and on the periodic poll).")
    }

    private func segment(_ title: String, active: Bool, _ tap: @escaping () -> Void) -> some View {
        Button(action: tap) {
            Text(title)
                .font(DS.Typography.labelMd())
                .foregroundStyle(active ? DS.Text.onPrimary : DS.Text.muted)
                .padding(.horizontal, 12)
                .padding(.vertical, 5)
                .background(active ? DS.Accent.primary : Color.clear, in: Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

#if DEBUG
#Preview {
    VStack(spacing: 16) {
        SyncCard(target: .constant(SyncTarget(
            id: "1", platform: .ghost,
            siteUrl: "example.ghost.io",
            state: .idle,
            lastSyncedRelative: "2 min ago",
            summary: "12 posts · vault/blog",
            autoSync: true)))
        SyncCard(target: .constant(SyncTarget(
            id: "2", platform: .shopify,
            siteUrl: "my-store.myshopify.com",
            state: .idle,
            lastSyncedRelative: "18 min ago",
            summary: "34 articles across 2 blogs",
            autoSync: false)))
        SyncCard(target: .constant(SyncTarget(
            id: "3", platform: .wordpress,
            siteUrl: "blog.example.com",
            state: .conflict,
            lastSyncedRelative: nil,
            summary: "7 posts · vault/blog/wp",
            autoSync: true,
            conflictCount: 1)))
    }
    .padding(24)
    .frame(width: 720)
    .background(DS.Surface.base)
}
#endif
