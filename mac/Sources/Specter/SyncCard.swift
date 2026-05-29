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
}

struct SyncCard: View {
    @Binding var target: SyncTarget

    var onPull: () -> Void = {}
    var onPush: () -> Void = {}
    var onDryRun: () -> Void = {}
    var onMore: () -> Void = {}
    var onResolveConflict: () -> Void = {}
    /// Called when the user toggles auto-sync. The Dashboard persists this
    /// to `config.targets[handle].syncMode` and restarts the daemon so the
    /// watcher picks up the new mode.
    var onAutoSyncChange: (Bool) -> Void = { _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Top row: status dot + platform + url ........ Auto toggle
            HStack(spacing: 12) {
                DSStatusDot(tone: statusTone)
                Text(target.platform.displayName)
                    .font(DS.Typography.headlineSm())
                    .foregroundStyle(DS.Text.primary)
                Text(target.siteUrl)
                    .font(DS.Typography.labelMd())
                    .foregroundStyle(DS.Text.outline)
                Spacer()
                AutoSyncToggle(isOn: Binding(
                    get: { target.autoSync },
                    set: { newValue in
                        target.autoSync = newValue
                        onAutoSyncChange(newValue)
                    }
                ))
            }

            // Status line
            HStack(spacing: 6) {
                Text(statusLabel)
                    .font(DS.Typography.labelMd())
                    .foregroundStyle(statusTextColor)
                if let last = target.lastSyncedRelative,
                   target.state != .conflict, target.state != .error {
                    Text("·")
                        .foregroundStyle(DS.Text.outline)
                    Text(last)
                        .font(DS.Typography.labelMd())
                        .foregroundStyle(DS.Text.outline)
                }
            }

            // Summary line
            Text(target.summary)
                .font(DS.Typography.bodyMd())
                .foregroundStyle(DS.Text.muted)

            // Actions
            HStack(spacing: 8) {
                if target.state == .conflict {
                    Button("Resolve conflict", action: onResolveConflict)
                        .buttonStyle(DSGhostButtonStyle(tone: DS.Status.warning))
                    Spacer()
                    Button(action: onMore) {
                        Image(systemName: "ellipsis")
                    }
                    .buttonStyle(DSGhostButtonStyle())
                } else {
                    Button("Pull",   action: onPull).buttonStyle(DSGhostButtonStyle())
                    Button("Push",   action: onPush).buttonStyle(DSGhostButtonStyle())
                    Button("Dry-run", action: onDryRun)
                        .buttonStyle(DSGhostButtonStyle(dashed: true))
                    Spacer()
                    Button(action: onMore) {
                        Image(systemName: "ellipsis")
                    }
                    .buttonStyle(DSGhostButtonStyle())
                }
            }
        }
        .dsCard()
    }

    // MARK: Helpers

    private var statusTone: DSStatusDot.Tone {
        switch target.state {
        case .idle, .syncing: return .success
        case .conflict:       return .warning
        case .error:          return .error
        case .disconnected:   return .idle
        }
    }

    private var statusLabel: String {
        switch target.state {
        case .idle:         return "Synced"
        case .syncing:      return "Syncing…"
        case .conflict:     return target.conflictCount == 1
            ? "1 conflict · resolve to continue"
            : "\(target.conflictCount) conflicts · resolve to continue"
        case .error:        return "Sync failed"
        case .disconnected: return "Disconnected"
        }
    }

    private var statusTextColor: Color {
        switch target.state {
        case .idle, .syncing, .disconnected: return DS.Text.muted
        case .conflict:                       return DS.Status.warning
        case .error:                          return DS.Status.error
        }
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
