/**
 * Tray icon + context menu.
 *
 * Menu structure mirrors mac/Sources/Specter/App.swift MenuView:
 *
 *   Specter [Manual] [Free]
 *   Status / message line
 *   Last sync: Xm ago
 *   ─────────────────────
 *   Sync Now
 *   Pull from Ghost
 *   Push to Ghost
 *   Preview Sync…
 *   ─────────────────────
 *   Open Specter…       (Dashboard window — mirrors Mac menu-bar item)
 *   Preferences…
 *   Launch at Login  /  Disable Launch at Login
 *   ─────────────────────
 *   Buy Specter Pro…   (Free users only)
 *   ─────────────────────
 *   Open Sync Folder
 *   View Logs
 *   Check for Updates…
 *   ─────────────────────
 *   Quit Specter
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
  shell,
  app,
  Notification,
  nativeImage,
  dialog,
} from 'electron';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { DaemonSupervisor } from './supervisor.js';
import { readState, lastSyncRelative } from './state.js';
import { readConfig, configExists } from './config.js';
import { checkForUpdates, canCheckForUpdates } from './updater.js';
import { daemonBundlePath, logFilePath, licenseStatePath } from './paths.js';
import { openWindow } from './windows.js';
import { autoLaunch } from './autolaunch.js';

const BUY_PRO_URL = 'https://spectersync.com/#buy';

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
  const { tier: licenseTier, syncCount } = readLicenseInfo();
  const isFree = licenseTier === 'free';
  const isManual = config?.syncMode === 'manual';
  const freeLimit = 200;

  const statusLabel = buildStatusLabel(supervisor, state, isManual);
  const lastSync = lastSyncRelative(state.lastSyncAt);

  const syncFolder =
    config?.vaultPath
      ? config.syncFolderPath
        ? path.join(config.vaultPath, config.syncFolderPath)
        : config.vaultPath
      : null;

  const menu = Menu.buildFromTemplate([
    // ── Header ────────────────────────────────────────────────────────────
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

    // ── Sync actions ──────────────────────────────────────────────────────
    {
      label: 'Sync Now',
      click: () => runDaemonCommand('sync', supervisor),
    },
    {
      label: 'Pull from Ghost',
      click: () => runDaemonCommand('pull', supervisor),
    },
    {
      label: 'Push to Ghost',
      click: () => runDaemonCommand('push', supervisor),
    },
    {
      label: 'Preview Sync…',
      click: () => openWindow('preview'),
    },
    { type: 'separator' },

    // ── App windows ───────────────────────────────────────────────────────
    {
      // Mirrors the Mac menu-bar "Open Specter…" item; opens the Dashboard
      // window. Spec: tasks/spec-multi-cms-ui.md S3.
      label: 'Open Specter…',
      click: () => openWindow('dashboard'),
    },
    {
      label: 'Preferences…',
      click: () => {
        if (configExists()) {
          openWindow('settings');
        } else {
          openWindow('onboarding');
        }
      },
    },
    {
      label: autoLaunch.isEnabled()
        ? 'Disable Launch at Login'
        : 'Launch at Login',
      click: () => autoLaunch.toggle(),
    },

    // ── Buy Pro (Free users only) ─────────────────────────────────────────
    ...(isFree
      ? [
          { type: 'separator' as const },
          {
            label: `Buy Specter Pro — ${syncCount}/${freeLimit} used`,
            click: () => shell.openExternal(BUY_PRO_URL),
          },
        ]
      : []),

    { type: 'separator' },

    // ── Utilities ─────────────────────────────────────────────────────────
    ...(syncFolder
      ? [
          {
            label: 'Open Sync Folder',
            click: () => shell.openPath(syncFolder!),
          },
        ]
      : []),
    {
      label: 'View Logs',
      click: () => shell.openPath(logFilePath()),
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
  if (isFree) label += '  [Free]';
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

// ── One-shot CLI runner (mirrors MenuActions.run in App.swift) ─────────────

function runDaemonCommand(
  cmd: 'sync' | 'pull' | 'push',
  supervisor: DaemonSupervisor,
): void {
  notify('Specter', `Running ${cmd}…`);

  const daemonPath = daemonBundlePath();
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };

  const child = spawn(process.execPath, [daemonPath, cmd], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));

  child.on('exit', (code) => {
    const state = readState();
    if (code === 0) {
      const msg = state.lastSyncMessage ?? 'Done';
      notify('Specter', `${cmd}: ${msg}`);
    } else if (isLicenseLimitError(stderr)) {
      notify(
        'Specter — Free limit reached',
        "You've used all 200 free uploads this month.",
      );
      showLicenseLimitDialog();
    } else {
      const errMsg = stderr.trim() || `Exit code ${code}`;
      notify('Specter failed', errMsg);
    }
    // Rebuild menu so "last sync" updates.
    if (tray) rebuildMenu(tray, supervisor);
  });
}

function isLicenseLimitError(raw: string): boolean {
  return raw.includes('Free tier upload limit reached');
}

function showLicenseLimitDialog(): void {
  dialog
    .showMessageBox({
      type: 'info',
      title: "You've reached your free limit",
      message: 'Free includes 200 uploads per month, across all connected sites.',
      detail:
        'Upgrade to Specter Pro for unlimited uploads — a one-time $49 purchase.',
      buttons: ['Upgrade to Specter Pro', 'Not Now'],
      defaultId: 0,
    })
    .then(({ response }) => {
      if (response === 0) shell.openExternal(BUY_PRO_URL);
    });
}

function notify(title: string, body: string): void {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
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
