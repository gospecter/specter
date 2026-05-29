# Local Unsigned Builds

The public repository is for source review, local development, adapter work, and self-built use under GNU AGPLv3.

Official SpecterSync binaries are built, signed, notarized, and published by a private release pipeline. That private pipeline contains production signing credentials, update-feed automation, and release infrastructure that is intentionally not mirrored into the public source repo.

## Daemon

```bash
npm install
npm run typecheck
npm test
npm run build
node bin/ghost-sync.mjs --help
```

## Electron App

```bash
cd desktop
npm install
npm run typecheck
npm run build
npm start
```

Local Electron packaging can be attempted with `electron-builder`, but public builds are unsigned and do not publish update feeds.

## macOS Swift App

The Swift shell can be built locally on macOS with Xcode and SwiftPM installed:

```bash
npm install
npm run build
cd mac
export SU_PUB_KEY="local-development-placeholder"
bash build-app.sh
```

The public `mac/fetch-node.sh` uses your locally installed `node` binary instead of downloading Node from the network. Official release builds use the private release pipeline.

## What Public Builds Do Not Include

- Apple Developer signing and notarization.
- Windows Trusted Signing.
- Sparkle private signing keys.
- Production appcasts or release-feed publishing.
- Private release/business infrastructure.

This split is deliberate: source builds are transparent and inspectable; official binaries are the trusted paid convenience distribution channel.
