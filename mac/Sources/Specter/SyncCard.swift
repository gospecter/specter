import SwiftUI

/// Spec: tasks/spec-multi-cms-ui.md — S3 Dashboard `SyncCard` component.
///
/// One card per connected target. Holds presentation only — actions are passed
/// in as closures so the Dashboard can wire them to the daemon.

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

    var onPull: () -> Void = {}
    var onPush: () -> Void = {}
    var onDryRun: () -> Void = {}
    var onEdit: () -> Void = {}
    var onTest: () -> Void = {}
    var onRemove: () -> Void = {}
    var onResolveConflict: () -> Void = {}
    /// Called when the user toggles auto-sync. The Dashboard persists this
    /// to `config.targets[handle].syncMode` and restarts the daemon so the
    /// watcher picks up the new mode.
    var onAutoSyncChange: (Bool) -> Void = { _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Top row: platform icon tile ........ status pill
            HStack(alignment: .top) {
                PlatformIconTile(systemName: target.platformIcon, size: 44)
                Spacer()
                DSPill(text: target.pill.text, tone: target.pill.tone, dot: true)
            }

            // Title + label
            VStack(alignment: .leading, spacing: 2) {
                Text(target.platform.displayName)
                    .font(DS.Typography.headlineMd())
                    .foregroundStyle(DS.Text.primary)
                Text(target.subtitle)
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

            // Footer: last sync (left) ........ actions (right)
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("LAST SYNC")
                        .font(DS.Typography.labelSm())
                        .foregroundStyle(DS.Text.outline)
                    Text(target.lastSyncText)
                        .font(DS.Typography.bodyMd())
                        .foregroundStyle(DS.Text.primary)
                }
                Spacer()
                actions
            }
        }
        .dsCard(padding: 24)
    }

    @ViewBuilder
    private var actions: some View {
        if target.state == .conflict {
            Button("Resolve conflict", action: onResolveConflict)
                .buttonStyle(DSGhostButtonStyle(tone: DS.Status.warning))
            moreMenu
        } else {
            AutoSyncToggle(isOn: Binding(
                get: { target.autoSync },
                set: { newValue in
                    target.autoSync = newValue
                    onAutoSyncChange(newValue)
                }
            ))
            Button("Pull now", action: onPull).buttonStyle(DSGhostButtonStyle())
            Button("Push now", action: onPush).buttonStyle(DSGhostButtonStyle())
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
    var subtitle: String {
        label.isEmpty ? siteUrl : label
    }

    var lastSyncText: String {
        switch state {
        case .error:        return "Sync failed"
        case .disconnected: return "Not connected"
        default:            return lastSyncedRelative ?? "Not synced yet"
        }
    }

    var platformIcon: String {
        switch platform {
        case .ghost:     return "doc.text"
        case .shopify:   return "bag"
        case .wordpress: return "globe"
        case .webflow:   return "square.grid.2x2"
        }
    }

    /// Status pill text + tone, mapped to the mockup vocabulary.
    var pill: (text: String, tone: DSPill.Tone) {
        switch state {
        case .error:        return ("ERROR", .error)
        case .conflict:
            return (conflictCount <= 1 ? "CONFLICT" : "\(conflictCount) CONFLICTS", .warning)
        case .syncing:      return ("INITIALIZING", .accent)
        case .disconnected: return ("DISCONNECTED", .neutral)
        case .idle:         return autoSync ? ("ACTIVE SYNCING", .accent) : ("PAUSED", .neutral)
        }
    }
}

/// Platform glyph in a rounded tile, matching the mockup's icon chip.
/// Shared by the grid card and the compact list row.
struct PlatformIconTile: View {
    let systemName: String
    var size: CGFloat = 44

    var body: some View {
        RoundedRectangle(cornerRadius: DS.Radius.base)
            .fill(DS.Surface.base)
            .frame(width: size, height: size)
            .overlay(
                RoundedRectangle(cornerRadius: DS.Radius.base)
                    .strokeBorder(DS.Surface.borderSubtle, lineWidth: 1)
            )
            .overlay(
                Image(systemName: systemName)
                    .font(.system(size: size * 0.4, weight: .medium))
                    .foregroundStyle(DS.Accent.primary)
            )
    }
}

/// Compact one-line variant of `SyncCard` for the Connections "list" layout.
/// Same data + closures, denser presentation.
struct SyncCardRow: View {
    @Binding var target: SyncTarget

    var onPull: () -> Void = {}
    var onPush: () -> Void = {}
    var onDryRun: () -> Void = {}
    var onEdit: () -> Void = {}
    var onTest: () -> Void = {}
    var onRemove: () -> Void = {}
    var onResolveConflict: () -> Void = {}
    var onAutoSyncChange: (Bool) -> Void = { _ in }

    var body: some View {
        HStack(spacing: 12) {
            PlatformIconTile(systemName: target.platformIcon, size: 32)

            VStack(alignment: .leading, spacing: 1) {
                Text(target.platform.displayName)
                    .font(DS.Typography.headlineSm())
                    .foregroundStyle(DS.Text.primary)
                Text(target.subtitle)
                    .font(DS.Typography.bodySm())
                    .foregroundStyle(DS.Text.muted)
                    .lineLimit(1)
            }
            .frame(minWidth: 120, alignment: .leading)

            DSPill(text: target.pill.text, tone: target.pill.tone, dot: true)

            Spacer()

            Text(target.lastSyncText)
                .font(DS.Typography.bodySm())
                .foregroundStyle(DS.Text.outline)
                .lineLimit(1)

            if target.state == .conflict {
                Button("Resolve", action: onResolveConflict)
                    .buttonStyle(DSGhostButtonStyle(tone: DS.Status.warning))
            } else {
                AutoSyncToggle(isOn: Binding(
                    get: { target.autoSync },
                    set: { newValue in
                        target.autoSync = newValue
                        onAutoSyncChange(newValue)
                    }
                ))
                Button("Pull", action: onPull).buttonStyle(DSGhostButtonStyle())
                Button("Push", action: onPush).buttonStyle(DSGhostButtonStyle())
            }

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
        .dsCard(padding: 12)
    }
}

/// Pill-shaped on/off switch in the Stitch accent color.
struct AutoSyncToggle: View {
    @Binding var isOn: Bool

    var body: some View {
        Button(action: { isOn.toggle() }) {
            HStack(spacing: 6) {
                Text("Auto")
                    .font(DS.Typography.labelSm())
                    .foregroundStyle(isOn ? DS.Text.onPrimary : DS.Text.outline)
                ZStack {
                    Capsule()
                        .fill(isOn ? DS.Accent.primary : DS.Surface.input)
                        .frame(width: 26, height: 14)
                    Circle()
                        .fill(isOn ? DS.Text.onPrimary : DS.Text.outline)
                        .frame(width: 10, height: 10)
                        .offset(x: isOn ? 6 : -6)
                }
            }
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
