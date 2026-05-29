/**
 * Cross-platform hardware machine ID.
 *
 * Returns a stable string that uniquely identifies the current machine.
 * The value is deterministic across calls on the same machine but is not
 * necessarily secret — callers should hash it before using as a fingerprint.
 *
 * Platform strategies:
 *   darwin — IOPlatformUUID via ioreg
 *   win32  — UUID via wmic (Win 10/11 ≤ 23H2) with PowerShell fallback (Win 11 24H2+)
 *   linux  — /sys/class/dmi/id/product_uuid (root-readable on most distros),
 *             with /etc/machine-id fallback
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';

export function getMachineId(): string {
  const platform = process.platform;
  if (platform === 'darwin') {
    return getMachineIdDarwin();
  }
  if (platform === 'win32') {
    return getMachineIdWin32();
  }
  if (platform === 'linux') {
    return getMachineIdLinux();
  }
  throw new Error(`Unable to determine machine ID on this platform`);
}

// ── darwin ─────────────────────────────────────────────────────────────────

function getMachineIdDarwin(): string {
  const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
    encoding: 'utf8',
  });
  const uuid = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1];
  if (uuid) return uuid;
  throw new Error('Unable to determine machine ID on this platform');
}

// ── win32 ──────────────────────────────────────────────────────────────────

function getMachineIdWin32(): string {
  // Try wmic first — available on Windows 10 and Windows 11 up to 23H2.
  try {
    const out = execFileSync('wmic', ['csproduct', 'get', 'UUID'], { encoding: 'utf8' });
    // Output format:
    //   UUID
    //   XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // lines[0] is the header "UUID", lines[1] is the value
    const uuid = lines[1];
    if (uuid && uuid !== 'UUID') return uuid;
  } catch {
    // wmic not available (Windows 11 24H2+ removed it) — fall through
  }

  // PowerShell fallback via CIM
  const out = execFileSync(
    'powershell',
    ['-NoProfile', '-Command', '(Get-CimInstance Win32_ComputerSystemProduct).UUID'],
    { encoding: 'utf8' },
  );
  const uuid = out.trim();
  if (uuid) return uuid;
  throw new Error('Unable to determine machine ID on this platform');
}

// ── linux ──────────────────────────────────────────────────────────────────

function getMachineIdLinux(): string {
  // /sys/class/dmi/id/product_uuid — available on most bare-metal / VM systems.
  // May require root on older kernels (EACCES).
  try {
    return fs.readFileSync('/sys/class/dmi/id/product_uuid', 'utf8').trim();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' && code !== 'ENOENT') throw err;
  }

  // /etc/machine-id — always readable, set at first boot.
  try {
    return fs.readFileSync('/etc/machine-id', 'utf8').trim();
  } catch {
    // fall through
  }

  throw new Error('Unable to determine machine ID on this platform');
}
