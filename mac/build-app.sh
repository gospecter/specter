#!/bin/bash
#
# Build the menu bar app, including:
#   - Compile Swift to a release binary
#   - esbuild the TS daemon into a single JS bundle
#   - Fetch the Node runtime
#   - Wrap everything into a self-contained .app bundle
#
# Output: mac/.build/Specter.app

set -euo pipefail
cd "$(dirname "$0")"
PROJECT_ROOT="$(cd .. && pwd)"

echo "==> Bundling daemon JS"
(cd "${PROJECT_ROOT}" && node esbuild.config.mjs)

echo "==> Fetching Node runtime"
bash ./fetch-node.sh

echo "==> Compiling Swift (universal arm64 + x86_64)"
swift build -c release --arch arm64 --arch x86_64

# Universal-build output path differs from single-arch builds:
#   single-arch:  .build/<triple>/release/
#   universal:    .build/apple/Products/Release/
SWIFT_BUILD_DIR="${PWD}/.build/apple/Products/Release"

APP="${PWD}/.build/Specter.app"
rm -rf "${APP}"
mkdir -p "${APP}/Contents/MacOS"
mkdir -p "${APP}/Contents/Resources"
mkdir -p "${APP}/Contents/Frameworks"

cp "${SWIFT_BUILD_DIR}/Specter" "${APP}/Contents/MacOS/Specter"

# SwiftPM's executable rpath points at the build dir, not @executable_path/../Frameworks.
# dyld then can't find Sparkle.framework at runtime. Patch in the standard .app rpath.
install_name_tool -add_rpath "@executable_path/../Frameworks" "${APP}/Contents/MacOS/Specter" 2>/dev/null || true

# Bundled runtime + daemon
cp vendor/node "${APP}/Contents/Resources/node"
cp "${PROJECT_ROOT}/dist/daemon.bundle.js" "${APP}/Contents/Resources/daemon.bundle.js"
cp "${PROJECT_ROOT}/dist/daemon.mjs" "${APP}/Contents/Resources/daemon.mjs"
cp "${PWD}/Assets/AppIcon.icns" "${APP}/Contents/Resources/AppIcon.icns"

# Bundled UI fonts (Sora + Inter, static weights). Registered with the system
# via ATSApplicationFontsPath in Info.plist below so the DesignSystem .custom()
# calls resolve instead of silently falling back to SF Pro. Without this the
# app renders in the system font and looks generic vs. the design mockups.
mkdir -p "${APP}/Contents/Resources/Fonts"
cp "${PWD}"/Assets/Fonts/*.ttf "${APP}/Contents/Resources/Fonts/"

# Bundled platform brand iconmarks (Ghost / Shopify / WordPress / Webflow),
# monochrome PNGs loaded as template images and tinted to the UI. Rendered by
# PlatformIconTile; falls back to an SF Symbol if a logo is missing.
mkdir -p "${APP}/Contents/Resources/Logos"
cp "${PWD}"/Assets/Logos/*.svg "${APP}/Contents/Resources/Logos/"

# Sparkle.framework — dyld looks for it at @rpath/.../Frameworks/Sparkle.framework
# when the app launches. Copy preserving symlinks so the Versions/B → Versions/Current
# structure stays intact (Apple's framework spec depends on it).
SPARKLE_SRC="${SWIFT_BUILD_DIR}/Sparkle.framework"
if [ -d "${SPARKLE_SRC}" ]; then
  /usr/bin/ditto "${SPARKLE_SRC}" "${APP}/Contents/Frameworks/Sparkle.framework"
else
  echo "ERROR: Sparkle.framework not found at ${SPARKLE_SRC}" >&2
  echo "Did 'swift build -c release --arch arm64 --arch x86_64' succeed?" >&2
  exit 1
fi

# SUPublicEDKey is the Ed25519 public key generated ONCE via Sparkle's
# bundled tool — see mac/sparkle/README.md. The matching private key signs
# each release via `sign_update` and stays in your Keychain. Rotating keys
# breaks updates for users on older versions, so don't rotate without a plan.
#
# Hard-fail if SU_PUB_KEY isn't exported. Silently substituting a placeholder
# here produces a build that runs, looks fine, and only fails when a user
# clicks "Check for Updates" days later (Sparkle 2 refuses to start the
# updater with an invalid Ed25519 public key). Bit us 2026-05-25; never
# again.
#
# To recover the key from your Keychain:
#   export SU_PUB_KEY="$(./mac/.build/artifacts/sparkle/Sparkle/bin/generate_keys -p)"
: "${SU_PUB_KEY:?must be exported before building — see mac/sparkle/README.md (run generate_keys -p to print the public key from your login Keychain)}"

cat > "${APP}/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key><string>Specter</string>
  <key>CFBundleExecutable</key><string>Specter</string>
  <key>CFBundleIdentifier</key><string>com.spectersync.specter</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleName</key><string>Specter</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.11.0</string>
  <key>CFBundleVersion</key><string>13</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>ATSApplicationFontsPath</key><string>Fonts</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>com.spectersync.specter.oauth</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>specter</string>
      </array>
    </dict>
  </array>
  <key>SUFeedURL</key><string>https://spectersync.com/appcast.xml</string>
  <key>SUPublicEDKey</key><string>${SU_PUB_KEY}</string>
  <key>SUEnableAutomaticChecks</key><true/>
  <key>SUScheduledCheckInterval</key><integer>86400</integer>
</dict>
</plist>
PLIST

# --- Stable code signature (dev) ---------------------------------------------
# Without a signature the bundle is ad-hoc, and an ad-hoc signature's hash
# changes on every build. macOS TCC keys folder/Privacy grants to the app's
# code signature, so each rebuild looks like a brand-new app and you get
# re-prompted ("Specter wants to access your Desktop folder…") every single
# build. Signing with a *stable* identity gives a constant designated
# requirement, so a folder grant you give once persists across rebuilds.
#
# Picks an explicit SPECTER_DEV_SIGN_ID if set, else the first Apple Development
# / Developer ID identity in your keychain (no personal cert hardcoded here, so
# this stays safe to export to the public repo). If none is found it leaves the
# build ad-hoc and just warns — the app still runs, you'll just keep getting
# prompts. Release signing/notarization is separate; see mac/release.sh.
SIGN_ID="${SPECTER_DEV_SIGN_ID:-$(security find-identity -v -p codesigning 2>/dev/null \
  | awk -F'"' '/Apple Development|Developer ID Application/{print $2; exit}')}"
if [ -n "${SIGN_ID}" ]; then
  # codesign refuses to sign over `com.apple.FinderInfo` detritus, and when the
  # project lives in an iCloud-synced tree (~/Documents…) those xattrs can't be
  # stripped in place — iCloud re-stamps them. So sign a clean copy in /tmp
  # (ditto --noextattr drops the xattrs) and copy the signed bundle back. The
  # embedded code signature on the main executable — which is what macOS TCC
  # keys folder/Privacy grants to — survives the round trip, giving a *stable*
  # designated requirement so a folder grant persists across rebuilds instead of
  # re-prompting every build. (Release signing/notarization is separate; see
  # mac/release.sh.)
  _stage="$(mktemp -d)"
  if /usr/bin/ditto --norsrc --noextattr --noacl "${APP}" "${_stage}/Specter.app" \
     && codesign --force --deep --sign "${SIGN_ID}" "${_stage}/Specter.app" 2>/dev/null; then
    rm -rf "${APP}"
    /usr/bin/ditto --norsrc --noextattr --noacl "${_stage}/Specter.app" "${APP}"
    echo "==> Signed dev build with \"${SIGN_ID}\""
    echo "    (grant Desktop/folder access once; it persists across rebuilds now)"
  else
    echo "==> WARN: codesign failed — build is ad-hoc, macOS will re-prompt for folder access on each build." >&2
  fi
  rm -rf "${_stage}"
else
  echo "==> No signing identity found — build stays ad-hoc (Desktop/Documents prompts will recur)." >&2
  echo "    Set SPECTER_DEV_SIGN_ID, or create an Apple Development cert in Xcode. See mac/release.sh." >&2
fi

SIZE=$(du -sh "${APP}" | cut -f1)
echo
echo "==> Built ${APP} (${SIZE})"
echo "Drag it to /Applications and double-click to launch."
