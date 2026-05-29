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
  <key>CFBundleShortVersionString</key><string>0.6.2</string>
  <key>CFBundleVersion</key><string>8</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
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

SIZE=$(du -sh "${APP}" | cut -f1)
echo
echo "==> Built ${APP} (${SIZE})"
echo "Drag it to /Applications and double-click to launch."
