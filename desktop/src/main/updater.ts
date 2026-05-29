/**
 * electron-updater wiring.
 *
 * Behaviour mirrors Sparkle on macOS:
 *  - autoDownload = false  (user must confirm before download)
 *  - Check at launch + every 24h
 *  - update-available → dialog "Download now?"
 *  - update-downloaded → dialog "Restart and install?"
 *
 * All events are logged to the standard log path.
 */

import { autoUpdater } from 'electron-updater';
import { dialog, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import { logFilePath } from './paths.js';

let checkInterval: ReturnType<typeof setInterval> | null = null;
let _canCheck = true;

export function canCheckForUpdates(): boolean {
  return _canCheck;
}

function log(msg: string): void {
  const line = `[updater] ${new Date().toISOString()} ${msg}\n`;
  try {
    const logFile = logFilePath();
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, line, 'utf8');
  } catch { /* non-fatal */ }
  console.log(line.trimEnd());
}

export function initUpdater(): void {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    _canCheck = false;
    log('Checking for updates…');
  });

  autoUpdater.on('update-not-available', () => {
    _canCheck = true;
    log('No update available.');
  });

  autoUpdater.on('error', (err: Error) => {
    _canCheck = true;
    log(`Update error: ${err.message}`);
  });

  autoUpdater.on('update-available', (info) => {
    _canCheck = true;
    log(`Update available: ${info.version}`);
    dialog
      .showMessageBox({
        type: 'info',
        title: 'Update Available',
        message: `Specter ${info.version} is available.`,
        detail: 'Download and install in the background?',
        buttons: ['Download Now', 'Later'],
        defaultId: 0,
      })
      .then(({ response }) => {
        if (response === 0) {
          log('User accepted download.');
          autoUpdater.downloadUpdate();
        } else {
          log('User deferred download.');
        }
      });
  });

  autoUpdater.on('download-progress', (progress) => {
    log(`Download progress: ${Math.round(progress.percent)}%`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    log(`Update downloaded: ${info.version}`);
    dialog
      .showMessageBox({
        type: 'info',
        title: 'Ready to Install',
        message: `Specter ${info.version} is ready.`,
        detail: 'Restart Specter now to apply the update?',
        buttons: ['Restart and Install', 'Later'],
        defaultId: 0,
      })
      .then(({ response }) => {
        if (response === 0) {
          log('Quitting to install update.');
          autoUpdater.quitAndInstall();
        }
      });
  });

  // Check on launch.
  checkForUpdates();

  // Check every 24h.
  checkInterval = setInterval(checkForUpdates, 24 * 60 * 60 * 1000);
}

export function checkForUpdates(): void {
  try {
    autoUpdater.checkForUpdates();
  } catch (err) {
    log(`checkForUpdates error: ${(err as Error).message}`);
  }
}

export function disposeUpdater(): void {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
}
