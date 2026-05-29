/**
 * Launch-at-login toggle using Electron's built-in app.setLoginItemSettings.
 * Mirrors mac/Sources/Specter/App.swift LoginItem enum.
 *
 * On Windows this writes a registry entry under
 * HKCU\Software\Microsoft\Windows\CurrentVersion\Run.
 * On Linux this uses Electron's openAtLogin for XDG autostart (systemd /
 * session manager support varies; best-effort).
 */

import { app } from 'electron';

function isEnabled(): boolean {
  return app.getLoginItemSettings().openAtLogin;
}

function toggle(): void {
  const current = isEnabled();
  app.setLoginItemSettings({
    openAtLogin: !current,
    // On Windows, pass the app path explicitly for NSIS installs.
    path: process.execPath,
    args: ['--hidden'],
  });
}

export const autoLaunch = { isEnabled, toggle };
