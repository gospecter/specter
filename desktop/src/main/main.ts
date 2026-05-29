/**
 * Electron app entry point.
 *
 * - Creates the system tray icon + menu.
 * - Spawns the sync daemon child process via DaemonSupervisor.
 * - Wires BrowserWindow instances for Settings, Onboarding, Preview.
 * - Initialises electron-updater.
 * - Registers IPC handlers.
 *
 * macOS is explicitly excluded — the polished SwiftUI shell in mac/ handles
 * macOS. This file guards against accidental macOS execution.
 */

import { app, BrowserWindow, Notification } from 'electron';
import { DaemonSupervisor } from './supervisor.js';
import { createTray, destroyTray } from './tray.js';
import { registerIpcHandlers } from './ipc.js';
import { initUpdater, disposeUpdater } from './updater.js';
import { configExists } from './config.js';
import { preloadPath, rendererPath } from './paths.js';
import { registerWindowOpener } from './windows.js';
import { findOAuthUrl, handleOAuthUrl, registerOAuthProtocol } from './oauth.js';

// ── Guard: Windows + Linux only ───────────────────────────────────────────────
if (process.platform === 'darwin') {
  console.error(
    'Specter desktop runs on Windows and Linux only. macOS uses the Swift app in mac/.',
  );
  process.exit(0);
}

// ── Singleton: prevent multiple app instances ─────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// ── State ─────────────────────────────────────────────────────────────────────
const supervisor = new DaemonSupervisor();
let settingsWin: BrowserWindow | null = null;
let onboardingWin: BrowserWindow | null = null;
let previewWin: BrowserWindow | null = null;
let dashboardWin: BrowserWindow | null = null;
let wordpressConnectWin: BrowserWindow | null = null;
const initialOAuthUrl = findOAuthUrl(process.argv);

// ── App lifecycle ─────────────────────────────────────────────────────────────

// Prevent the app from quitting when all windows are closed — it lives in the
// tray.
// Subscribing to this event is itself enough to prevent the default quit
// behaviour on Win/Linux — Electron treats any subscriber as taking control.
app.on('window-all-closed', () => {
  /* keep running in tray */
});

app.on('second-instance', (_event, argv) => {
  const oauthUrl = findOAuthUrl(argv);
  if (oauthUrl) void handleOAuthUrl(oauthUrl);
});

app.whenReady().then(() => {
  registerOAuthProtocol();

  // Hide from taskbar — tray-only app.
  // (app.dock is undefined on Windows/Linux; no-op guard.)
  if (typeof (app as unknown as { dock?: { hide(): void } }).dock?.hide === 'function') {
    (app as unknown as { dock: { hide(): void } }).dock.hide();
  }

  // Register window openers before creating the tray (tray calls openWindow).
  registerWindowOpener('settings', openSettingsWindow);
  registerWindowOpener('onboarding', openOnboardingWindow);
  registerWindowOpener('preview', openPreviewWindow);
  registerWindowOpener('dashboard', openDashboardWindow);
  registerWindowOpener('wordpress-connect', openWordPressConnectWindow);

  createTray(supervisor);
  registerIpcHandlers(supervisor);
  initUpdater();

  // Start the daemon if already configured; otherwise open onboarding.
  if (configExists()) {
    supervisor.start();
  } else {
    openOnboardingWindow();
  }

  if (initialOAuthUrl) void handleOAuthUrl(initialOAuthUrl);

  // Handle crash loop — show a native notification.
  supervisor.on('crash-loop', (msg: string) => {
    if (Notification.isSupported()) {
      new Notification({
        title: 'Specter daemon stopped',
        body: msg,
      }).show();
    }
  });
});

app.on('before-quit', () => {
  supervisor.stop();
  destroyTray();
  disposeUpdater();
});

// ── Window factory ────────────────────────────────────────────────────────────

function makeWindow(
  name: string,
  width: number,
  height: number,
): BrowserWindow {
  const win = new BrowserWindow({
    width,
    height,
    resizable: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(rendererPath(name));

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });

  // Prevent external links from opening in the app window.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  return win;
}

// ── Window openers ────────────────────────────────────────────────────────────

function openSettingsWindow(): void {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  // Matches Swift settings window: 620×560
  settingsWin = makeWindow('settings', 620, 560);
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

function openOnboardingWindow(): void {
  if (onboardingWin && !onboardingWin.isDestroyed()) {
    onboardingWin.show();
    onboardingWin.focus();
    return;
  }
  // Matches Swift onboarding window: 560×480
  onboardingWin = makeWindow('onboarding', 560, 480);
  onboardingWin.on('closed', () => {
    onboardingWin = null;
  });
}

function openPreviewWindow(): void {
  if (previewWin && !previewWin.isDestroyed()) {
    previewWin.show();
    previewWin.focus();
    return;
  }
  // Matches Swift preview window: 620×520
  previewWin = makeWindow('preview', 620, 520);
  previewWin.on('closed', () => {
    previewWin = null;
  });
}

function openWordPressConnectWindow(): void {
  if (wordpressConnectWin && !wordpressConnectWin.isDestroyed()) {
    wordpressConnectWin.show();
    wordpressConnectWin.focus();
    return;
  }
  // Matches Swift WordPress connect window: 560×480.
  wordpressConnectWin = makeWindow('wordpress-connect', 560, 480);
  wordpressConnectWin.on('closed', () => {
    wordpressConnectWin = null;
  });
}

function openDashboardWindow(): void {
  if (dashboardWin && !dashboardWin.isDestroyed()) {
    dashboardWin.show();
    dashboardWin.focus();
    return;
  }
  // Dashboard is the new multi-target hero window. Spec: tasks/spec-multi-cms-ui.md S3.
  // Larger and resizable, unlike the fixed-size onboarding/settings/preview popovers.
  dashboardWin = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 960,
    minHeight: 600,
    resizable: true,
    fullscreenable: true,
    minimizable: true,
    maximizable: true,
    show: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  dashboardWin.loadFile(rendererPath('dashboard'));
  dashboardWin.once('ready-to-show', () => {
    dashboardWin?.show();
    dashboardWin?.focus();
  });
  dashboardWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  dashboardWin.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  dashboardWin.on('closed', () => {
    dashboardWin = null;
  });
}
