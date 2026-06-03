/**
 * Tray icon + context menu.
 *
 * The tray is a STATUS surface, not a control panel (spec
 * tasks/spec-app-redesign-ux-overhaul.md §4). Everything else — Sync/Pull/Push,
 * Preview, Preferences, Launch at Login, Open Folder, View Logs, Buy Pro — now
 * lives in the dashboard window. Menu structure:
 *
 *   Specter [Manual] [Not activated]
 *   Status / message line
 *   Last sync: Xm ago
 *   ─────────────────────
 *   Open Specter…       (Dashboard window — the single home)
 *   Check for Updates…
 *   ─────────────────────
 *   Quit Specter        ⌘Q
 *
 * On Linux, setContextMenu must be re-called after any mutation because
 * libappindicator doesn't support dynamic updates. We always rebuild from
 * scratch and call setContextMenu on every refresh.
 *
 * Tray icon caveat on Linux:
 * - GNOME removed legacy tray support in v3.26+. Users need the AppIndicator
 *   extension: https://extensions.gnome.org/extension/615/appindicator-support/
 * - On Wayland, the tray API behaviour differs by compositor.
 * - We do not log a warning on GNOME without AppIndicator because Electron's
 *   Tray API will silently no-op — the window-toggle accelerator (no-op for
 *   tray-only apps) is the fallback UX path for users in that state.
 */

import {
  Tray,
  Menu,
  app,
  nativeImage,
} from 'electron';
import path from 'path';
import fs from 'fs';
import { DaemonSupervisor } from './supervisor.js';
import { readState, lastSyncRelative } from './state.js';
import { readConfig, configExists } from './config.js';
import { checkForUpdates, canCheckForUpdates } from './updater.js';
import { licenseStatePath } from './paths.js';
import { openWindow } from './windows.js';

let tray: Tray | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

export function createTray(supervisor: DaemonSupervisor): Tray {
  // TODO: replace with actual branded icon before release.
  // Brand references: specterbg.png / specterlogo.png in repo root.
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'tray-icon.png')
    : path.join(__dirname, '..', '..', 'assets', 'tray-icon.png');

  let icon = nativeImage.createEmpty();
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (process.platform === 'win32') {
      icon = icon.resize({ width: 16, height: 16 });
    }
  } catch { /* use empty icon as fallback */ }

  tray = new Tray(icon);
  tray.setToolTip('Specter');

  rebuildMenu(tray, supervisor);

  // Refresh state every 5 seconds (matches StatusStore timer in Swift).
  refreshTimer = setInterval(() => {
    if (tray) rebuildMenu(tray, supervisor);
  }, 5000);

  // Also rebuild on supervisor status changes.
  supervisor.on('status-change', () => {
    if (tray) rebuildMenu(tray, supervisor);
  });

  return tray;
}

export function destroyTray(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  tray?.destroy();
  tray = null;
}

export function rebuildMenu(tray: Tray, supervisor: DaemonSupervisor): void {
  const state = readState();
  const config = readConfig();
  const { tier: licenseTier } = readLicenseInfo();
  const isFree = licenseTier === 'free';
  const isManual = config?.syncMode === 'manual';

  const statusLabel = buildStatusLabel(supervisor, state, isManual);
  const lastSync = lastSyncRelative(state.lastSyncAt);

  const menu = Menu.buildFromTemplate([
    // ── Header (status surface) ───────────────────────────────────────────
    {
      label: buildHeaderLabel(isManual, isFree),
      enabled: false,
    },
    {
      label: statusLabel,
      enabled: false,
    },
    {
      label: `Last sync: ${lastSync}`,
      enabled: false,
    },
    { type: 'separator' },

    // ── App windows ───────────────────────────────────────────────────────
    {
      // The single home for every control and preference. When no config
      // exists yet we route to onboarding instead so first-run still works.
      label: 'Open Specter…',
      click: () => openWindow(configExists() ? 'dashboard' : 'onboarding'),
    },
    {
      label: 'Check for Updates…',
      enabled: canCheckForUpdates(),
      click: () => checkForUpdates(),
    },

    { type: 'separator' },

    // ── Quit ──────────────────────────────────────────────────────────────
    {
      label: 'Quit Specter',
      accelerator: 'CmdOrCtrl+Q',
      click: () => {
        supervisor.stop();
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);
}

// ── Header label ──────────────────────────────────────────────────────────

function buildHeaderLabel(isManual: boolean, isFree: boolean): string {
  let label = 'Specter';
  if (isManual) label += '  [Manual]';
  if (isFree) label += '  [Not activated]';
  return label;
}

function buildStatusLabel(
  supervisor: DaemonSupervisor,
  state: ReturnType<typeof readState>,
  isManual: boolean,
): string {
  if (!supervisor.isRunning) return 'Daemon stopped';
  if (state.lastSyncMessage) return state.lastSyncMessage;
  return isManual ? 'Pulling on schedule only' : 'Watching for changes…';
}

// ── License helpers ────────────────────────────────────────────────────────

interface LicenseInfo {
  tier: 'free' | 'pro';
  syncCount: number;
}

function readLicenseInfo(): LicenseInfo {
  try {
    const raw = fs.readFileSync(licenseStatePath(), 'utf8');
    const parsed = JSON.parse(raw) as {
      tier?: string;
      syncCount?: number;
    };
    return {
      tier: parsed.tier === 'pro' ? 'pro' : 'free',
      syncCount: parsed.syncCount ?? 0,
    };
  } catch {
    return { tier: 'free', syncCount: 0 };
  }
}
