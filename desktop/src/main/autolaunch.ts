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

function set(enabled: boolean): void {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    // On Windows, pass the app path explicitly for NSIS installs.
    path: process.execPath,
    args: ['--hidden'],
  });
}

function toggle(): void {
  set(!isEnabled());
}

export const autoLaunch = { isEnabled, set, toggle };
