# Electron Hardening

The Electron shell is used for Windows and Linux. macOS uses the SwiftUI shell.

## Currently Enforced

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- IPC handlers reject non-`file://` sender frames.
- Renderer navigation is blocked with `will-navigate`.
- New windows are denied with `setWindowOpenHandler`.

## Electron Fuses

Electron Fuses are build-time switches that permanently disable risky Electron runtime features in a packaged app. They are useful because they reduce what an attacker can do even if a renderer bug appears later.

Examples include disabling Node CLI inspection flags and limiting where app code can load from.

## Current Status

Fuses are planned for the official packaging pipeline. They are not required for local unsigned source builds, but official release builds should enable them once the packaged Windows/Linux apps have been tested with the fuse configuration.
