Asset placeholders — replace with final branded icons before release.
Brand references in repo root: specterbg.png, specterbluebg.png, specterlogo.png

Required files:
  tray-icon.png      — 16x16 (Windows) or 22x22 (Linux) tray/system-tray icon
  tray-icon.ico      — Windows ICO (16x16, 32x32, 48x48, 256x256)
  app-icon.png       — 256x256 or 512x512 application icon (Linux)
  app-icon.ico       — Windows application icon
  installer-icon.ico — NSIS installer icon (must be .ico; referenced in electron-builder.yml)

electron-builder will fail at package time if the ICO files are missing.
Create minimal placeholder ICOs before running dist:win.
