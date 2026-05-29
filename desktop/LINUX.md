# Specter on Linux

## Installation

### AppImage
1. Download `Specter-0.3.0-x86_64.AppImage`
2. Make it executable: `chmod +x Specter-0.3.0-x86_64.AppImage`
3. Run: double-click in your file manager, or from terminal: `./Specter-0.3.0-x86_64.AppImage`

**Note**: Ubuntu 22.04+ and Fedora 36+ removed libfuse2. Install before running:
```bash
sudo apt install libfuse2          # Ubuntu/Debian
sudo dnf install fuse-libs         # Fedora/RHEL
```

### Debian/Ubuntu (.deb)
```bash
sudo dpkg -i Specter-0.3.0-amd64.deb
sudo apt-get install -f            # Install dependencies if needed
```

Then launch from your app menu or run `specter`.

## Tray Icon

**GNOME (v3.26+)**: The tray icon requires the AppIndicator extension. Install from:
https://extensions.gnome.org/extension/615/appindicator-support/

KDE, XFCE, Cinnamon, MATE: Works out of the box.

## Auto-Updates

- **AppImage**: Updates in-place via electron-updater. Select "Download Now" in the dialog.
- **.deb**: No apt repo provided in v0.3. Re-download and reinstall when updates are available.

## Config and Data

- **Config**: `~/.config/ghost-sync/config.json`
- **State**: `~/.local/state/ghost-sync/state.json`
- **Logs**: `~/.local/state/ghost-sync/logs/`

## Launch at Login

Enable via Settings → "Launch at Login". Writes a systemd `--user` unit to:
```
~/.config/systemd/user/ghost-sync.service
```

Disable via the same setting.
