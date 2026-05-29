import SwiftUI

/// Spec: tasks/spec-multi-cms-ui.md — S1 First-run platform picker.
/// Used both by first-run onboarding and the "+ Add target" flow in settings.

enum Platform: String, CaseIterable, Identifiable {
    case ghost, shopify, wordpress

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .ghost:     return "Ghost"
        case .shopify:   return "Shopify"
        case .wordpress: return "WordPress"
        }
    }

    /// One-line connect-method label rendered in mono under the tile name.
    var connectHint: String {
        switch self {
        case .ghost:     return "Admin key paste"
        case .shopify:   return "OAuth"
        case .wordpress: return "One-click authorize"
        }
    }

    /// Initial glyph (placeholder until brand SVGs are bundled).
    var initial: String {
        String(displayName.first!)
    }

    /// Accent color for the tile glyph.
    var accent: Color {
        switch self {
        case .ghost:     return DS.Text.primary
        case .shopify:   return DS.Status.success
        case .wordpress: return DS.Accent.onDark
        }
    }
}

struct PlatformPickerView: View {
    /// Locked tiles render the Pro badge and reject taps. Free tier locks all
    /// but the first chosen platform.
    var lockedPlatforms: Set<Platform> = []
    var onSelect: (Platform) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Space.section) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Welcome to Specter")
                    .font(DS.Typography.headlineLg())
                    .foregroundStyle(DS.Text.primary)
                Text("Sync any CMS to a folder of markdown.")
                    .font(DS.Typography.bodyLg())
                    .foregroundStyle(DS.Text.muted)
            }

            VStack(alignment: .leading, spacing: DS.Space.gutter) {
                Text("Connect your first platform")
                    .font(DS.Typography.headlineSm())
                    .foregroundStyle(DS.Text.primary)

                HStack(spacing: DS.Space.gutter) {
                    ForEach(Platform.allCases) { platform in
                        PlatformTile(
                            platform: platform,
                            locked: lockedPlatforms.contains(platform)
                        ) {
                            onSelect(platform)
                        }
                    }
                }
            }

            Text("Coming soon · Drupal · Joomla")
                .font(DS.Typography.labelSm())
                .foregroundStyle(DS.Text.outline)
        }
        .padding(48)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(DS.Surface.base)
    }
}

private struct PlatformTile: View {
    let platform: Platform
    let locked: Bool
    let action: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: { if !locked { action() } }) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text(platform.initial)
                        .font(DS.Typography.headlineMd())
                        .foregroundStyle(platform.accent)
                        .frame(width: 32, height: 32)
                        .background(DS.Surface.input, in: RoundedRectangle(cornerRadius: DS.Radius.base))
                    Spacer()
                    if locked {
                        DSPill(text: "PRO", tone: .success)
                    }
                }
                Spacer(minLength: 0)
                Text(platform.displayName)
                    .font(DS.Typography.headlineSm())
                    .foregroundStyle(DS.Text.primary)
                Text(platform.connectHint)
                    .font(DS.Typography.labelSm())
                    .foregroundStyle(DS.Text.outline)
            }
            .padding(DS.Space.gutter)
            .frame(width: 200, height: 180, alignment: .topLeading)
            .background(DS.Surface.elevated)
            .overlay(
                RoundedRectangle(cornerRadius: DS.Radius.lg)
                    .strokeBorder(borderColor, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: DS.Radius.lg))
            .opacity(locked ? 0.55 : 1.0)
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
    }

    private var borderColor: Color {
        if locked { return DS.Surface.borderSubtle }
        return isHovered ? DS.Accent.primary.opacity(0.4) : DS.Surface.borderSubtle
    }
}

#if DEBUG
#Preview {
    PlatformPickerView(lockedPlatforms: [.wordpress]) { platform in
        print("Selected: \(platform.rawValue)")
    }
    .frame(width: 800, height: 520)
}
#endif
