/**
 * IPC handlers exposed to renderer windows via the preload contextBridge.
 *
 * Channel naming: <namespace>:<action>
 * All handlers are async and return plain JSON-serialisable values.
 *
 * Channels:
 *   config:read                 → AppConfig | null
 *   config:write                → { ok: true } | { ok: false; error: string }
 *   config:exists               → boolean
 *   config:set-target-sync-mode → { ok: true } | { ok: false; error: string }
 *   ghost:test                  → { ok: boolean; message: string }
 *   daemon:status               → { status: SupervisorStatus; lastError: string | null }
 *   daemon:start                → void
 *   daemon:stop                 → void
 *   daemon:restart              → void
 *   license:status              → LicenseStatus JSON (from daemon CLI) | null
 *   license:activate            → { ok: boolean; error?: string }
 *   license:deactivate          → { ok: boolean; error?: string }
 *   dialog:pickFolder           → string | null
 *   preview:fetch               → SyncPlan JSON | { error: string }
 *   dashboard:fetch             → DashboardSnapshot { targets: DashboardTarget[] }
 *   dashboard:run-command       → { ok: boolean; error?: string; message?: string }
 */

import { ipcMain, dialog, BrowserWindow, shell, type IpcMainInvokeEvent } from 'electron';
import { spawnSync } from 'child_process';
import {
  readConfig,
  writeConfig,
  AppConfig,
  configExists,
  setTargetSyncMode,
  upsertWordPressTarget,
} from './config.js';
import { readState } from './state.js';
import { buildDashboardSnapshot } from './dashboard-snapshot.js';
import { DaemonSupervisor } from './supervisor.js';
import { daemonBundlePath } from './paths.js';
import {
  openWindow,
  setPendingPreviewTarget,
  consumePendingPreviewTarget,
} from './windows.js';

let supervisor: DaemonSupervisor | null = null;

export function registerIpcHandlers(sup: DaemonSupervisor): void {
  supervisor = sup;

  // ── Config ───────────────────────────────────────────────────────────────

  handleTrusted('config:read', () => readConfig());

  handleTrusted('config:exists', () => configExists());

  handleTrusted('config:write', (_event, cfg: AppConfig) => {
    try {
      writeConfig(cfg);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // ── Ghost connection test ─────────────────────────────────────────────────

  handleTrusted(
    'ghost:test',
    (_event, ghostUrl: string, adminApiKey: string) => {
      return runDaemonJson([
        'test',
        '--url',
        ghostUrl,
        '--key',
        adminApiKey,
        '--json',
      ]);
    },
  );

  // ── WordPress connection test + connect ──────────────────────────────────
  //
  // Both routes for the Phase 7 "Add WordPress site" form. `test` is the ad-hoc
  // check (no config write); `connect` upserts a WordPress target into
  // `config.targets[]` and restarts the supervised daemon so the watcher picks
  // up the new target without the user having to relaunch.

  handleTrusted(
    'wordpress:test',
    (_event, siteUrl: string, username: string, appPassword: string) => {
      return runDaemonJson([
        'test',
        '--platform', 'wordpress',
        '--site-url', siteUrl,
        '--username', username,
        '--app-password', appPassword,
        '--json',
      ]);
    },
  );

  handleTrusted(
    'wordpress:connect',
    (_event, payload: { siteUrl: string; username: string; appPassword: string }) => {
      const { siteUrl, username, appPassword } = payload ?? ({} as typeof payload);
      if (!siteUrl || !username || !appPassword) {
        return { ok: false, error: 'Missing site URL, username, or application password.' };
      }
      try {
        upsertWordPressTarget(siteUrl, username, appPassword);
        if (supervisor && supervisor.isRunning) {
          try { supervisor.restart(); } catch { /* best-effort */ }
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  // ── Daemon ───────────────────────────────────────────────────────────────

  handleTrusted('daemon:status', () => ({
    status: supervisor?.status ?? 'stopped',
    lastError: supervisor?.lastError ?? null,
  }));

  handleTrusted('daemon:start', () => {
    supervisor?.start();
  });

  handleTrusted('daemon:stop', () => {
    supervisor?.stop();
  });

  handleTrusted('daemon:restart', () => {
    supervisor?.restart();
  });

  // ── License ──────────────────────────────────────────────────────────────
  //
  // All license operations delegate to the daemon CLI which is the source of
  // truth for license state (mirrors LicenseController in License.swift).
  // TODO: plug in the correct activate/deactivate endpoint URL via the daemon's
  //       ghost-sync license <subcommand> --json interface — see
  //       src/license/keygen.ts for the Keygen API calls.

  handleTrusted('license:status', () =>
    runDaemonJson(['license', 'status', '--json']),
  );

  handleTrusted('license:activate', (_event, key: string) =>
    runDaemonJson(['license', 'activate', key, '--json']),
  );

  handleTrusted('license:deactivate', () =>
    runDaemonJson(['license', 'deactivate', '--json']),
  );

  // ── Native folder picker ─────────────────────────────────────────────────

  handleTrusted('dialog:pickFolder', async (_event) => {
    // Find the focused window so the dialog sheets correctly on Windows.
    const win = BrowserWindow.getFocusedWindow() ?? undefined;
    const result = await dialog.showOpenDialog(win ?? ({} as BrowserWindow), {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose Sync Folder',
      buttonLabel: 'Choose Folder',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // ── Preview (dry-run) ─────────────────────────────────────────────────────
  //
  // When the dashboard's per-card "Dry-run" button opens the preview window,
  // `setPendingPreviewTarget(handle)` stashes a one-shot target handle. The
  // first `preview:fetch` after that consumes it and passes `--target` to the
  // daemon so the plan is per-target rather than vault-wide. Subsequent
  // refreshes (without a pending handle) fall back to the unfiltered plan.

  handleTrusted('preview:fetch', () => {
    const handle = consumePendingPreviewTarget();
    const args = ['sync', '--dry-run', '--json'];
    if (handle) args.push('--target', handle);
    return runDaemonJson(args);
  });

  // ── Dashboard (read-only view-model from config + state) ─────────────────

  handleTrusted('dashboard:fetch', () =>
    buildDashboardSnapshot(readConfig(), readState()),
  );

  // ── One-shot sync trigger (used by Preview "Run Sync Now") ───────────────────
  // Fire-and-forget: the preview window closes before the sync completes.

  handleTrusted('daemon:run-sync', (_event, cmd: 'sync' | 'pull' | 'push' = 'sync') => {
    const { spawn } = require('child_process') as typeof import('child_process');
    const bundle = daemonBundlePath();
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    spawn(process.execPath, [bundle, cmd], {
      env,
      stdio: 'ignore',
      detached: false,
    });
    return { ok: true };
  });

  // ── Per-target dashboard actions ────────────────────────────────────────────
  //
  // The dashboard's per-card buttons (Pull / Push / Sync / Dry-run) route
  // through here. Each invocation spawns a short-lived `node daemon.mjs <cmd>
  // --target <handle>` process — same node/daemon resolution path the
  // supervisor uses. The watcher daemon keeps running undisturbed.
  //
  // Pull / Push / Sync: we wait for the child to exit so the renderer can
  // re-fetch the dashboard snapshot once daemon truth has settled.
  //
  // Dry-run: we hand off to the existing Preview window. The window opens
  // (or focuses if already open) with the target handle pinned, and its
  // `preview:fetch` invocation routes the same target through to the daemon.

  handleTrusted(
    'dashboard:run-command',
    (
      _event,
      payload: { command: 'pull' | 'push' | 'sync' | 'dry-run'; handle: string },
    ) => {
      const { command, handle } = payload ?? ({} as typeof payload);
      if (!handle || typeof handle !== 'string') {
        return { ok: false, error: 'Missing target handle.' };
      }
      if (command === 'dry-run') {
        setPendingPreviewTarget(handle);
        openWindow('preview');
        return { ok: true };
      }
      if (command !== 'pull' && command !== 'push' && command !== 'sync') {
        return { ok: false, error: `Unknown command: ${String(command)}` };
      }
      return runDaemonCommand([command, '--target', handle]);
    },
  );

  // ── Window opening + external links ────────────────────────────────────────
  //
  // The dashboard's "+ Add target" dropdown needs to ask the main process to
  // open the right surface for each platform: Ghost goes to the legacy
  // Settings (or Onboarding when no config exists yet), Shopify is a browser
  // hop to spectersync.com/connect-shopify, WordPress opens the local connect
  // window. Renderers can't import './windows.js' directly, so we expose a
  // narrow channel that names the registered window.

  handleTrusted('windows:open', (_event, name: string) => {
    if (typeof name !== 'string' || name.length === 0) {
      return { ok: false, error: 'Missing window name.' };
    }
    if (name === 'settings-or-onboarding') {
      openWindow(configExists() ? 'settings' : 'onboarding');
    } else {
      openWindow(name);
    }
    return { ok: true };
  });

  handleTrusted('shell:openExternal', async (_event, url: string) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return { ok: false, error: 'Only http(s) URLs are allowed.' };
    }
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // ── Persist per-target Auto-sync toggle ─────────────────────────────────────
  //
  // Atomic write (tempfile + rename + chmod 600 on POSIX) lives in config.ts.
  // After persisting, restart the supervised watcher so its in-memory copy of
  // the config — and hence the per-target sync mode — picks up the new value.

  handleTrusted(
    'config:set-target-sync-mode',
    (_event, payload: { handle: string; mode: 'auto' | 'manual' }) => {
      const { handle, mode } = payload ?? ({} as typeof payload);
      if (!handle || (mode !== 'auto' && mode !== 'manual')) {
        return { ok: false, error: 'Invalid payload.' };
      }
      const result = setTargetSyncMode(handle, mode);
      if (result.ok && supervisor && supervisor.isRunning) {
        try { supervisor.restart(); } catch { /* best-effort */ }
      }
      return result;
    },
  );
}

// ── Helper ────────────────────────────────────────────────────────────────

type TrustedHandler = (event: IpcMainInvokeEvent, ...args: any[]) => unknown;

function handleTrusted(channel: string, listener: TrustedHandler): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event)) {
      return { ok: false, error: 'Untrusted IPC sender.' };
    }
    return listener(event, ...args);
  });
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  return url.startsWith('file://');
}

/**
 * Run a daemon subcommand via ELECTRON_RUN_AS_NODE and return parsed JSON.
 * This is a synchronous call on a background thread from ipcMain.handle
 * (Electron's IPC runs handlers in the Node.js event loop so sync child_process
 * is acceptable here — it won't block the renderer).
 *
 * Returns the parsed JSON object on success, or { ok: false, error: string }
 * on failure.
 */
function runDaemonJson(args: string[]): unknown {
  const bundle = daemonBundlePath();
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };

  try {
    const result = spawnSync(process.execPath, [bundle, ...args], {
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });

    const stdout = result.stdout?.trim() ?? '';
    const stderr = result.stderr?.trim() ?? '';

    if (result.error) {
      return { ok: false, error: result.error.message };
    }

    // Try to parse JSON from stdout first.
    if (stdout) {
      try {
        return JSON.parse(stdout);
      } catch { /* fall through */ }
    }

    if (result.status !== 0) {
      return { ok: false, error: stderr || `Exit code ${result.status}` };
    }

    // stdout wasn't valid JSON but exit was 0 — return raw string.
    return { ok: true, message: stdout };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Run a daemon subcommand and resolve once the child exits. Unlike
 * `runDaemonJson`, the output isn't parsed — these commands write their human
 * progress to stderr/the log file. The caller only cares whether the exit
 * code is zero so it knows to surface success vs failure on the dashboard
 * card. Stderr is captured and returned on non-zero exit so the renderer can
 * show a meaningful error (invalid handle, missing config, etc.).
 *
 * 5-minute timeout — generous enough for a 1k-post pull, tight enough that a
 * stuck child doesn't pin the renderer's "syncing" indicator forever.
 */
function runDaemonCommand(args: string[]): { ok: boolean; error?: string; message?: string } {
  const bundle = daemonBundlePath();
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };

  try {
    const result = spawnSync(process.execPath, [bundle, ...args], {
      env,
      encoding: 'utf8',
      timeout: 5 * 60_000,
    });

    if (result.error) {
      return { ok: false, error: result.error.message };
    }
    if (result.signal) {
      return { ok: false, error: `Daemon terminated with signal ${result.signal}` };
    }
    if (result.status !== 0) {
      const stderr = result.stderr?.trim() ?? '';
      const stdout = result.stdout?.trim() ?? '';
      return {
        ok: false,
        error: stderr || stdout || `Exit code ${result.status}`,
      };
    }
    return { ok: true, message: result.stdout?.trim() ?? '' };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
