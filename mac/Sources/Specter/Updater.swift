import Foundation
import Sparkle
import SwiftUI

/// Wraps Sparkle's standard updater so SwiftUI views can talk to it.
///
/// Sparkle reads its configuration from Info.plist:
///   - `SUFeedURL` → https://spectersync.com/appcast.xml
///   - `SUPublicEDKey` → owner's Ed25519 public key (base64)
///
/// On first launch Sparkle asks the user whether to enable automatic checks.
/// "Check for Updates…" in the menu always works regardless of that prompt.
@MainActor
final class UpdaterController: ObservableObject {
    let updaterController: SPUStandardUpdaterController

    init() {
        // startingUpdater: true → Sparkle starts watching for updates as soon
        // as the app launches. updaterDelegate / userDriverDelegate left nil
        // because the default UI is fine for a single-product app.
        self.updaterController = SPUStandardUpdaterController(
            startingUpdater: true,
            updaterDelegate: nil,
            userDriverDelegate: nil
        )
    }

    /// Bound to the menu item — kicks off a foreground update check with the
    /// standard "checking…" / "you're up to date" / "update available" UI.
    func checkForUpdates() {
        updaterController.checkForUpdates(nil)
    }

    var canCheck: Bool {
        updaterController.updater.canCheckForUpdates
    }
}
