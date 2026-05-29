/**
 * Cross-platform desktop notifications.
 *
 * Basic notifications use `node-notifier` which works on macOS, Linux
 * (libnotify / notify-send), and Windows (Balloon / Snackbar).
 *
 * The synchronous conflict-resolution dialog cannot be expressed via
 * node-notifier (it needs a blocking multi-button prompt), so it uses a
 * per-platform approach:
 *   darwin  — osascript display dialog (original behaviour)
 *   win32   — PowerShell Windows.MessageBox
 *   linux   — zenity, then kdialog, then "skip" fallback
 */

import { spawnSync } from 'node:child_process';
import notifier from 'node-notifier';

function escape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function notify(title: string, message: string, subtitle?: string): void {
  try {
    notifier.notify({
      title,
      message,
      subtitle,
      // On macOS, node-notifier falls back to terminal-notifier / osascript
      // depending on what is available; on Linux it uses notify-send; on
      // Windows it uses a native notification toast.
      sound: false,
    });
  } catch {
    // best-effort
  }
}

/**
 * Prompt the user to choose between local and remote for a conflict.
 * Returns the chosen resolution, or `skip` if the user dismissed.
 * This call is intentionally synchronous so the sync engine can block on it.
 */
export function promptConflict(title: string): 'keep_local' | 'keep_remote' | 'skip' {
  const platform = process.platform;

  if (platform === 'darwin') {
    return promptConflictDarwin(title);
  }
  if (platform === 'win32') {
    return promptConflictWin32(title);
  }
  return promptConflictLinux(title);
}

// ── darwin ─────────────────────────────────────────────────────────────────

function promptConflictDarwin(title: string): 'keep_local' | 'keep_remote' | 'skip' {
  const script = `display dialog "Conflict: ${escape(title)}\\n\\nBoth local and Ghost versions changed since the last sync. Which one should win?" with title "Specter" buttons {"Keep Ghost", "Skip", "Keep Local"} default button "Skip" cancel button "Skip"`;
  try {
    const res = spawnSync('osascript', ['-e', script], { encoding: 'utf8' });
    if (res.status !== 0) return 'skip';
    const out = res.stdout || '';
    if (out.includes('Keep Local')) return 'keep_local';
    if (out.includes('Keep Ghost')) return 'keep_remote';
    return 'skip';
  } catch {
    return 'skip';
  }
}

// ── win32 ──────────────────────────────────────────────────────────────────

function promptConflictWin32(title: string): 'keep_local' | 'keep_remote' | 'skip' {
  // Windows.MessageBox buttons:
  //   YesNoCancel = 3  →  Yes=6, No=7, Cancel=2
  // We map: Yes → Keep Local, No → Keep Remote, Cancel → Skip
  const message = `Conflict: ${title}\n\nBoth local and Ghost versions changed since the last sync. Which one should win?\n\n[Yes] Keep Local   [No] Keep Ghost   [Cancel] Skip`;
  const encodedMessage = Buffer.from(message, 'utf16le').toString('base64');
  const encodedCaption = Buffer.from('Specter', 'utf16le').toString('base64');
  const script = [
    'Add-Type -AssemblyName PresentationFramework;',
    `$message = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedMessage}'));`,
    `$caption = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedCaption}'));`,
    '$result = [System.Windows.MessageBox]::Show($message, $caption, [System.Windows.MessageBoxButton]::YesNoCancel, [System.Windows.MessageBoxImage]::Question);',
    'Write-Output $result',
  ].join(' ');

  try {
    const res = spawnSync('powershell', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
    });
    if (res.status !== 0) return 'skip';
    const out = (res.stdout || '').trim();
    if (out === 'Yes') return 'keep_local';
    if (out === 'No') return 'keep_remote';
    return 'skip';
  } catch {
    return 'skip';
  }
}

// ── linux ──────────────────────────────────────────────────────────────────

function promptConflictLinux(title: string): 'keep_local' | 'keep_remote' | 'skip' {
  const message = `Conflict: ${title}\n\nBoth local and Ghost versions changed since the last sync.\nClick Yes to Keep Local, No to Keep Ghost, or Cancel to Skip.`;

  // Try zenity first (GNOME / most distros)
  const zenity = spawnSync(
    'zenity',
    ['--question', '--title=Specter', `--text=${message}`, '--ok-label=Keep Local', '--cancel-label=Skip', '--extra-button=Keep Ghost'],
    { encoding: 'utf8' },
  );
  if (zenity.error === undefined || (zenity.error as NodeJS.ErrnoException).code !== 'ENOENT') {
    // zenity is installed; exit 0 = "Keep Local" (--ok-label), 1 = Skip (cancel), extra button printed to stdout
    if (zenity.status === 0) return 'keep_local';
    const out = (zenity.stdout || '').trim();
    if (out === 'Keep Ghost') return 'keep_remote';
    return 'skip';
  }

  // Try kdialog (KDE)
  const kdialog = spawnSync(
    'kdialog',
    ['--yesnocancel', message, '--title', 'Specter', '--yes-label', 'Keep Local', '--no-label', 'Keep Ghost'],
    { encoding: 'utf8' },
  );
  if (kdialog.error === undefined || (kdialog.error as NodeJS.ErrnoException).code !== 'ENOENT') {
    // kdialog exit: 0=Yes (Keep Local), 1=No (Keep Ghost), 2=Cancel (Skip)
    if (kdialog.status === 0) return 'keep_local';
    if (kdialog.status === 1) return 'keep_remote';
    return 'skip';
  }

  // Neither zenity nor kdialog available — default to skip
  process.stderr.write(
    '[ghost-sync] WARNING: No GUI dialog tool found (zenity/kdialog). ' +
      `Conflict for "${title}" will be skipped. ` +
      'Install zenity or kdialog to enable interactive conflict resolution.\n',
  );
  return 'skip';
}
