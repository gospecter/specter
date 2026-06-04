import AppKit
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
    // Tokens match the dark-dashboard mockup: near-black-green base, blue accent.
    enum Surface {
        static let base       = Color(hex: 0x020A07)
        static let panel      = Color(hex: 0x1B221F)
        static let elevated   = Color(hex: 0x242C28)
        static let input      = Color(hex: 0x0C0F10)
        static let hover      = Color.white.opacity(0.04)
        static let pressed    = Color.white.opacity(0.08)
        static let borderSubtle = Color(hex: 0x2D3632)
        static let borderStrong = Color(hex: 0x3C463F)
    }

    // MARK: Text
    enum Text {
        static let primary     = Color(hex: 0xFFFFFF)
        static let muted       = Color(hex: 0xA1ADA8)
        static let outline     = Color(hex: 0x6E7B75)
        static let onPrimary   = Color(hex: 0xFFFFFF)
    }

    // MARK: Accent (Blue Ribbon #0A66FF)
    enum Accent {
        static let primary     = Color(hex: 0x0A66FF)
        static let onDark      = Color(hex: 0x8FBEFF)
        static let fixed       = Color(hex: 0x0A4FCC)
        static let soft        = Color(hex: 0x0A66FF).opacity(0.15)
        static let tertiary    = Color(hex: 0xFFB964)
    }

    // MARK: Status
    enum Status {
        static let success = Color(hex: 0x23C48E)
        static let warning = Color(hex: 0xFF6B35)
        static let error   = Color(hex: 0xFF6B35)
    }

    // MARK: Typography
    /// Sora (headings) + Inter (body/labels) — the typefaces the design mockups
    /// render. Static weights are bundled in `mac/Assets/Fonts/` and registered
    /// at launch via `ATSApplicationFontsPath` (see build-app.sh). We reference
    /// each weight by its exact PostScript name (e.g. "Sora-SemiBold") rather
    /// than `.custom(...).weight(...)`, because synthetic weight selection on a
    /// custom family is unreliable — naming the face is deterministic. If a face
    /// fails to load, .custom() falls back to SF gracefully.
    /// Two roles, kept deliberately narrow so a page doesn't read as a font
    /// salad: **Sora** is the *display* face — page titles and the wordmark
    /// only — and **Inter** does ALL functional UI text at just two weights
    /// (Regular + SemiBold). Previously Sora-Medium leaked into table rows and
    /// section heads while Inter ran Regular/SemiBold/Bold, so a single screen
    /// showed ~5 distinct faces. Headings stay Sora; everything operational is
    /// Inter.
    enum Typography {
        // Display → Sora SemiBold (hero headings + wordmark only)
        static func displayLg() -> Font  { .custom("Sora-ExtraBold", size: 56) }
        static func headlineXl() -> Font { .custom("Sora-SemiBold", size: 40) }  // page title
        static func headlineLg() -> Font { .custom("Sora-SemiBold", size: 30) }
        static func headlineMd() -> Font { .custom("Sora-SemiBold", size: 22) }  // large section hero
        static func wordmark()   -> Font { .custom("Sora-SemiBold", size: 17) }  // sidebar "Specter"
        // UI text → Inter (Regular for prose, SemiBold for emphasis/labels)
        static func headlineSm() -> Font { .custom("Inter-SemiBold", size: 15) }  // row/section titles
        static func bodyLg() -> Font  { .custom("Inter-Regular", size: 16) }
        static func bodyMd() -> Font  { .custom("Inter-Regular", size: 14) }
        static func bodySm() -> Font  { .custom("Inter-Regular", size: 12) }
        static func labelMd() -> Font { .custom("Inter-SemiBold", size: 12) }  // buttons, mode, nav
        static func labelSm() -> Font { .custom("Inter-SemiBold", size: 11) }  // uppercase pills + table headers
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

// MARK: - Date parsing

/// Parse the ISO-8601 timestamps the daemon writes to state.json. Those carry
/// fractional seconds (e.g. `2026-06-04T09:49:09.079Z`), which a default
/// `ISO8601DateFormatter` REJECTS — so every parse silently returned nil,
/// making synced connections read "NEVER SYNCED" and Sync Logs timestamps show
/// "—". Try fractional first, then fall back to plain for any non-fractional
/// strings. Formatters are reused (allocating one per call is measurably slow).
enum ISO8601 {
    private static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    static func parse(_ s: String) -> Date? {
        fractional.date(from: s) ?? plain.date(from: s)
    }
}

// MARK: - Native vibrancy

/// Translucent sidebar background using the system `.sidebar` material, the
/// same vibrancy native macOS sidebars use (Finder, Mail, Notes). `.behindWindow`
/// blends the desktop through, giving the LookAway / Superwhisper feel.
///
/// Requires the host window to be non-opaque with a clear background color
/// (`isOpaque = false`, `backgroundColor = .clear`) — otherwise the effect
/// renders as a flat color. That's configured once in `DashboardView.onAppear`.
struct VibrancySidebar: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = .sidebar
        view.blendingMode = .behindWindow
        view.state = .active            // stay vibrant even when unfocused
        return view
    }
    func updateNSView(_ view: NSVisualEffectView, context: Context) {}
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
///
/// Hover-reactive: the label gains a soft fill and a brighter border on hover,
/// and a stronger fill on press, so it reads as a clickable control (the
/// previous flat style gave no affordance — "is this even a button?"). A
/// `ButtonStyle` can't observe hover directly, so the body is a small inner
/// view that owns its own `@State`.
struct DSGhostButtonStyle: ButtonStyle {
    var dashed: Bool = false
    var tone: Color = DS.Text.primary

    func makeBody(configuration: Configuration) -> some View {
        GhostButtonBody(configuration: configuration, dashed: dashed, tone: tone)
    }

    private struct GhostButtonBody: View {
        let configuration: Configuration
        let dashed: Bool
        let tone: Color
        @State private var isHovered = false

        var body: some View {
            configuration.label
                .font(DS.Typography.labelMd())
                .foregroundStyle(tone.opacity(configuration.isPressed ? 0.7 : 1))
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(
                    RoundedRectangle(cornerRadius: DS.Radius.base)
                        .fill(fill)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: DS.Radius.base)
                        .strokeBorder(
                            isHovered ? DS.Surface.borderStrong : DS.Surface.borderSubtle,
                            style: StrokeStyle(lineWidth: 1, dash: dashed ? [4, 3] : [])
                        )
                )
                .contentShape(RoundedRectangle(cornerRadius: DS.Radius.base))
                .onHover { hovering in
                    isHovered = hovering
                    if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
                }
                .animation(.easeOut(duration: 0.12), value: isHovered)
                .animation(.easeOut(duration: 0.10), value: configuration.isPressed)
        }

        private var fill: Color {
            if configuration.isPressed { return DS.Surface.pressed }
            if isHovered { return DS.Surface.hover }
            return .clear
        }
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

/// Content-kind picker — a column of toggles, one per kind the platform
/// supports. Opt-in: nothing is pre-checked for a new connection (the caller
/// seeds `selected` from the target's current kinds when editing). Zero
/// selected is allowed (the target then syncs nothing).
///
/// Shared by the Ghost / WordPress connect forms and the per-card Edit sheet
/// so all three platforms get an identical selector.
struct ContentKindSelector: View {
    let platform: Platform
    @Binding var selected: [String]
    /// Overrides the static `ContentKinds.available(for:)` list — pass the live
    /// kinds for platforms whose kinds are dynamic (Webflow collections).
    var availableKinds: [String]? = nil

    private var kinds: [String] {
        availableKinds ?? ContentKinds.available(for: platform)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(kinds, id: \.self) { kind in
                Toggle(isOn: binding(for: kind)) {
                    Text(label(for: kind))
                }
                .toggleStyle(.checkbox)
            }
            if selected.isEmpty {
                Label("Nothing selected — this connection won't sync anything.",
                      systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func binding(for kind: String) -> Binding<Bool> {
        Binding(
            get: { selected.contains(kind) },
            set: { isOn in
                if isOn {
                    if !selected.contains(kind) { selected.append(kind) }
                } else {
                    selected.removeAll { $0 == kind }
                }
            }
        )
    }

    private func label(for kind: String) -> String {
        // Dynamic Webflow kinds render their collection slug verbatim.
        if kind.hasPrefix("webflow:") {
            return String(kind.dropFirst("webflow:".count))
        }
        return kind.prefix(1).uppercased() + kind.dropFirst() + "s"
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
    /// Leading status dot (mockup status pills). Off by default.
    var dot: Bool = false
    /// Animate the dot with a soft pulse (mockup "ACTIVE SYNCING" / live states).
    var pulse: Bool = false

    enum Tone { case neutral, success, warning, error, accent }

    @State private var pulsing = false

    var body: some View {
        HStack(spacing: 5) {
            if dot {
                Circle()
                    .fill(fg)
                    .frame(width: 5, height: 5)
                    .scaleEffect(pulse && pulsing ? 1.35 : 1.0)
                    .opacity(pulse && pulsing ? 0.45 : 1.0)
                    .animation(pulse ? .easeInOut(duration: 1.0).repeatForever(autoreverses: true) : .default,
                               value: pulsing)
                    .onAppear { if pulse { pulsing = true } }
            }
            Text(text)
                .font(DS.Typography.labelSm())
                .tracking(0.8)
                .textCase(.uppercase)
                .foregroundStyle(fg)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(bg, in: Capsule())
        .overlay(Capsule().strokeBorder(stroke, lineWidth: 1))
    }

    // Mockup pill style: tinted background (~12% of the tone) + tone-colored
    // text, not a solid fill. Neutral keeps a hairline border.
    private var bg: Color {
        switch tone {
        case .success: return DS.Status.success.opacity(0.12)
        case .warning: return DS.Status.warning.opacity(0.12)
        case .error:   return DS.Status.error.opacity(0.12)
        case .accent:  return DS.Accent.soft
        case .neutral: return DS.Surface.elevated
        }
    }
    private var fg: Color {
        switch tone {
        case .success: return DS.Status.success
        case .warning: return DS.Status.warning
        case .error:   return DS.Status.error
        case .accent:  return DS.Accent.primary
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
