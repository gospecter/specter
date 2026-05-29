/**
 * Linux systemd --user service install/uninstall.
 *
 * Writes a systemd user unit to the XDG config directory and enables it via
 * `systemctl --user`.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { logPath, loadConfig, requireConfig } from '../../config.js';

const SERVICE_NAME = 'ghost-sync.service';

function systemdUserDir(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'systemd', 'user');
}

function unitPath(): string {
  return path.join(systemdUserDir(), SERVICE_NAME);
}

/** Resolve the daemon entry point in order of preference. */
function findDaemon(): string {
  const here = path.resolve(process.argv[1], '..', '..'); // two levels up from bin/ghost-sync.mjs
  const candidates = [
    path.join(here, 'dist', 'daemon.bundle.js'),
    path.join(here, 'dist', 'daemon.mjs'),
    path.join(here, 'bin', 'ghost-sync.mjs'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Fallback: the currently-running script
  return path.resolve(process.argv[1]);
}

function buildUnit(execStart: string, log: string): string {
  return `[Unit]
Description=Ghost Sync Daemon
After=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=5
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`;
}

function systemctl(...args: string[]): { ok: boolean; output: string } {
  const res = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' });
  return {
    ok: res.status === 0,
    output: (res.stdout || res.stderr || '').trim(),
  };
}

export async function install(): Promise<{ ok: boolean; message: string }> {
  requireConfig(await loadConfig());

  const node = process.execPath;
  const daemon = findDaemon();
  const log = logPath();

  // Ensure the log directory exists.
  mkdirSync(path.dirname(log), { recursive: true });

  const execStart = `${node} ${daemon} watch`;
  const unit = buildUnit(execStart, log);

  mkdirSync(systemdUserDir(), { recursive: true });
  writeFileSync(unitPath(), unit, 'utf8');

  const reload = systemctl('daemon-reload');
  if (!reload.ok) {
    return { ok: false, message: `systemctl --user daemon-reload failed: ${reload.output}` };
  }

  const enable = systemctl('enable', '--now', SERVICE_NAME);
  if (!enable.ok) {
    return { ok: false, message: `systemctl --user enable --now failed: ${enable.output}` };
  }

  return {
    ok: true,
    message: [
      `Installed systemd user unit: ${unitPath()}`,
      `Logs: ${log}`,
      `Use 'systemctl --user status ${SERVICE_NAME}' to inspect.`,
    ].join('\n'),
  };
}

export async function uninstall(): Promise<{ ok: boolean; message: string }> {
  systemctl('disable', '--now', SERVICE_NAME);

  try {
    await fs.unlink(unitPath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  systemctl('daemon-reload');

  return { ok: true, message: `Removed systemd user unit: ${unitPath()}` };
}

export async function status(): Promise<{ ok: boolean; message: string }> {
  const res = systemctl('status', SERVICE_NAME);
  return { ok: res.ok, message: res.output || 'Service not found.' };
}
