import SwiftUI

/// Specter Design System — Stitch tokens (1:1).
/// Reference: tasks/spec-multi-cms-ui.md
/// Stitch:    projects/14005065681931464655
///
/// All multi-platform surfaces (Dashboard, platform picker, conflict resolver)
/// consume these tokens. Legacy surfaces (existing Onboarding / Settings) keep
/// SwiftUI's stock semantic colors; this module is additive.
enum DS {

    // MARK: Surfaces (tonal layering — no shadows)
    enum Surface {
        static let base       = Color(hex: 0x111416)
        static let panel      = Color(hex: 0x1D2022)
        static let elevated   = Color(hex: 0x232629)
        static let input      = Color(hex: 0x0C0F10)
        static let hover      = Color.white.opacity(0.04)
        static let pressed    = Color.white.opacity(0.08)
        static let borderSubtle = Color(hex: 0x34393E)
        static let borderStrong = Color(hex: 0x484553)
    }

    // MARK: Text
    enum Text {
        static let primary     = Color(hex: 0xE1E2E5)
        static let muted       = Color(hex: 0xCAC4D5)
        static let outline     = Color(hex: 0x938E9E)
        static let onPrimary   = Color(hex: 0xEFE8FF)
    }

    // MARK: Accent
    enum Accent {
        static let primary     = Color(hex: 0x6E56CF)
        static let onDark      = Color(hex: 0xCBBEFF)
        static let fixed       = Color(hex: 0x4A2EA9)
        static let soft        = Color(hex: 0x6E56CF).opacity(0.16)
        static let tertiary    = Color(hex: 0xFFB964)
    }

    // MARK: Status
    enum Status {
        static let success = Color(hex: 0x30A46C)
        static let warning = Color(hex: 0xFFB224)
        static let error   = Color(hex: 0xE54D2E)
    }

    // MARK: Typography
    /// We register Hanken Grotesk + JetBrains Mono in Info.plist when the
    /// fonts are bundled with the app. Until then, the .custom() initializers
    /// fall back to the system font gracefully.
    enum Typography {
        static func headlineLg() -> Font {
            .custom("Hanken Grotesk", size: 32).weight(.semibold)
        }
        static func headlineMd() -> Font {
            .custom("Hanken Grotesk", size: 24).weight(.semibold)
        }
        static func headlineSm() -> Font {
            .custom("Hanken Grotesk", size: 18).weight(.medium)
        }
        static func bodyLg() -> Font {
            .custom("Hanken Grotesk", size: 16)
        }
        static func bodyMd() -> Font {
            .custom("Hanken Grotesk", size: 14)
        }
        static func bodySm() -> Font {
            .custom("Hanken Grotesk", size: 12)
        }
        static func labelMd() -> Font {
            .custom("JetBrains Mono", size: 13).weight(.medium)
        }
        static func labelSm() -> Font {
            .custom("JetBrains Mono", size: 11).weight(.medium)
        }
    }

    // MARK: Geometry
    enum Space {
        static let unit:     CGFloat = 4
        static let gutter:   CGFloat = 16
        static let section:  CGFloat = 24
        static let sidebarW: CGFloat = 280
        static let containerMax: CGFloat = 1200
    }

    enum Radius {
        static let sm:   CGFloat = 4
        static let base: CGFloat = 8   // buttons, inputs
        static let md:   CGFloat = 12
        static let lg:   CGFloat = 16  // cards, modals
    }
}

// MARK: - Hex Color helper

extension Color {
    /// Hex literal init: `Color(hex: 0x6E56CF)`.
    init(hex: UInt32, alpha: Double = 1.0) {
        let r = Double((hex >> 16) & 0xFF) / 255.0
        let g = Double((hex >>  8) & 0xFF) / 255.0
        let b = Double( hex        & 0xFF) / 255.0
        self.init(.sRGB, red: r, green: g, blue: b, opacity: alpha)
    }
}

// MARK: - View helpers

/// Standard elevated card surface: panel background + 1px ghost border + lg radius.
struct DSCardStyle: ViewModifier {
    var padding: CGFloat = DS.Space.gutter
    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(DS.Surface.elevated)
            .overlay(
                RoundedRectangle(cornerRadius: DS.Radius.lg)
                    .stroke(DS.Surface.borderSubtle, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: DS.Radius.lg))
    }
}

extension View {
    func dsCard(padding: CGFloat = DS.Space.gutter) -> some View {
        modifier(DSCardStyle(padding: padding))
    }
}

/// Ghost button: transparent fill + 1px border. Pass `dashed: true` for dry-run.
struct DSGhostButtonStyle: ButtonStyle {
    var dashed: Bool = false
    var tone: Color = DS.Text.primary

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(DS.Typography.labelMd())
            .foregroundStyle(tone)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: DS.Radius.base)
                    .fill(configuration.isPressed ? DS.Surface.pressed : Color.clear)
            )
            .overlay(
                RoundedRectangle(cornerRadius: DS.Radius.base)
                    .strokeBorder(
                        DS.Surface.borderSubtle,
                        style: StrokeStyle(
                            lineWidth: 1,
                            dash: dashed ? [4, 3] : []
                        )
                    )
            )
    }
}

/// Primary button: accent fill, light text.
struct DSPrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(DS.Typography.labelMd())
            .foregroundStyle(DS.Text.onPrimary)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: DS.Radius.base)
                    .fill(configuration.isPressed
                          ? DS.Accent.primary.opacity(0.85)
                          : DS.Accent.primary)
            )
    }
}

/// 8px status dot — success / warning / error.
struct DSStatusDot: View {
    enum Tone { case success, warning, error, idle }
    var tone: Tone

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 8, height: 8)
    }

    private var color: Color {
        switch tone {
        case .success: return DS.Status.success
        case .warning: return DS.Status.warning
        case .error:   return DS.Status.error
        case .idle:    return DS.Text.outline
        }
    }
}

/// Pill-shaped chip — pass tone for color (success = Pro badge, accent = platform pill).
struct DSPill: View {
    var text: String
    var tone: Tone = .neutral

    enum Tone { case neutral, success, warning, error, accent }

    var body: some View {
        Text(text)
            .font(DS.Typography.labelSm())
            .foregroundStyle(fg)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(bg, in: Capsule())
            .overlay(Capsule().strokeBorder(stroke, lineWidth: 1))
    }

    private var bg: Color {
        switch tone {
        case .success: return DS.Status.success
        case .warning: return DS.Status.warning.opacity(0.18)
        case .error:   return DS.Status.error.opacity(0.18)
        case .accent:  return DS.Accent.soft
        case .neutral: return DS.Surface.elevated
        }
    }
    private var fg: Color {
        switch tone {
        case .success: return Color(hex: 0x06231A)
        case .warning: return DS.Status.warning
        case .error:   return DS.Status.error
        case .accent:  return DS.Accent.onDark
        case .neutral: return DS.Text.muted
        }
    }
    private var stroke: Color {
        switch tone {
        case .success, .warning, .error, .accent: return .clear
        case .neutral: return DS.Surface.borderSubtle
        }
    }
}
