/**
 * Windows Task Scheduler install/uninstall via `schtasks`.
 *
 * Creates an ONLOGON task that runs `ghost-sync watch` under the current user
 * with limited privileges. Output is appended to the user-local log file.
 */

import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { logPath, loadConfig, requireConfig } from '../../config.js';

const TASK_NAME = 'GhostSync';

/** Resolve the daemon entry point in order of preference. */
function findDaemon(): string {
  const here = path.resolve(process.argv[1], '..', '..');
  const candidates = [
    path.join(here, 'dist', 'daemon.bundle.js'),
    path.join(here, 'dist', 'daemon.mjs'),
    path.join(here, 'bin', 'ghost-sync.mjs'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return path.resolve(process.argv[1]);
}

function schtasks(...args: string[]): { ok: boolean; output: string } {
  const res = spawnSync('schtasks', args, { encoding: 'utf8' });
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

  // Ensure the log directory exists before the task writes to it.
  mkdirSync(path.dirname(log), { recursive: true });

  // schtasks /TR value: cmd /c runs the node process and appends output.
  // Outer quotes are required by schtasks; inner paths are double-quoted.
  const tr = `cmd /c ""${node}" "${daemon}" watch >> "${log}" 2>&1"`;

  const result = schtasks(
    '/Create',
    '/TN', TASK_NAME,
    '/TR', tr,
    '/SC', 'ONLOGON',
    '/RL', 'LIMITED',
    '/F',
  );

  if (!result.ok) {
    return { ok: false, message: `Failed to create scheduled task: ${result.output}` };
  }

  return {
    ok: true,
    message: [
      `Installed scheduled task: ${TASK_NAME}`,
      `Logs: ${log}`,
      `Use 'schtasks /Query /TN ${TASK_NAME} /FO LIST' to inspect.`,
    ].join('\n'),
  };
}

export async function uninstall(): Promise<{ ok: boolean; message: string }> {
  const result = schtasks('/Delete', '/TN', TASK_NAME, '/F');
  if (!result.ok && !result.output.includes('cannot find')) {
    return { ok: false, message: `Failed to delete scheduled task: ${result.output}` };
  }
  return { ok: true, message: `Removed scheduled task: ${TASK_NAME}` };
}

export async function status(): Promise<{ ok: boolean; message: string }> {
  const result = schtasks('/Query', '/TN', TASK_NAME, '/FO', 'LIST');
  return { ok: result.ok, message: result.output || 'Task not found.' };
}
