/**
 * Per-OS paths used by the Electron app.
 * Mirrors the logic in mac/Sources/Specter/Paths.swift and the daemon's
 * src/config.ts — must stay in sync with both.
 *
 * Config:  $XDG_CONFIG_HOME/ghost-sync/config.json
 *          %APPDATA%\ghost-sync\config.json  (Windows)
 *
 * State:   $XDG_STATE_HOME/ghost-sync/state.json
 *          %LOCALAPPDATA%\ghost-sync\state.json  (Windows)
 *
 * Log:     $XDG_STATE_HOME/ghost-sync/logs/ghost-sync.log  (Linux)
 *          %LOCALAPPDATA%\ghost-sync\logs\ghost-sync.log  (Windows)
 */

import path from 'path';
import os from 'os';
import { app } from 'electron';

function home(): string {
  return os.homedir();
}

export function configDir(): string {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(home(), 'AppData', 'Roaming');
    return path.join(base, 'ghost-sync');
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(home(), '.config');
  return path.join(base, 'ghost-sync');
}

export function configFilePath(): string {
  return path.join(configDir(), 'config.json');
}

export function stateDir(): string {
  if (process.platform === 'win32') {
    const base =
      process.env.LOCALAPPDATA || path.join(home(), 'AppData', 'Local');
    return path.join(base, 'ghost-sync');
  }
  const base =
    process.env.XDG_STATE_HOME || path.join(home(), '.local', 'state');
  return path.join(base, 'ghost-sync');
}

export function stateFilePath(): string {
  return path.join(stateDir(), 'state.json');
}

export function logFilePath(): string {
  if (process.platform === 'win32') {
    const base =
      process.env.LOCALAPPDATA || path.join(home(), 'AppData', 'Local');
    return path.join(base, 'ghost-sync', 'logs', 'ghost-sync.log');
  }
  // Linux (darwin is macOS — not expected here, but handled gracefully)
  const base =
    process.env.XDG_STATE_HOME || path.join(home(), '.local', 'state');
  return path.join(base, 'ghost-sync', 'logs', 'ghost-sync.log');
}

/**
 * Resolves the daemon bundle at runtime.
 *
 * Packaged:  process.resourcesPath is set by Electron to the Resources dir
 *            inside the installed app. electron-builder copies
 *            dist/daemon.bundle.js there via extraResources.
 * Dev:       Resolve relative to this compiled file which sits at
 *            desktop/build/main/paths.js → three levels up is the repo root.
 */
export function daemonBundlePath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'daemon.bundle.js');
  }
  // __dirname = desktop/build/main  →  ../../..  = repo root
  return path.resolve(__dirname, '..', '..', '..', 'dist', 'daemon.bundle.js');
}

/**
 * License state lives alongside state.json:
 *   Linux:   $XDG_STATE_HOME/ghost-sync/license.json
 *   Windows: %LOCALAPPDATA%\ghost-sync\license.json
 */
export function licenseStatePath(): string {
  return path.join(stateDir(), 'license.json');
}

export function preloadPath(): string {
  return path.join(__dirname, '..', 'preload', 'preload.js');
}

export function rendererPath(name: string): string {
  // In dev + packaged both land in build/renderer/<name>/index.html
  return path.join(__dirname, '..', 'renderer', name, 'index.html');
}
