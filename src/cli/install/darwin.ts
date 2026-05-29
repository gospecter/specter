/**
 * macOS launchd LaunchAgent install/uninstall.
 *
 * Writes a plist that runs `ghost-sync watch` under the user's session, with
 * stdout/stderr piped to the platform log path. KeepAlive restarts the
 * daemon if it crashes; RunAtLoad starts it when the user logs in.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { logPath, loadConfig, requireConfig } from '../../config.js';

const LABEL = 'com.axel.ghost-sync';

function plistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function findBin(): string {
  return path.resolve(process.argv[1]);
}

function buildPlist(node: string, script: string, log: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${script}</string>
    <string>watch</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
`;
}

export async function install(): Promise<{ ok: boolean; message: string }> {
  // Validate config before installing — no point starting a daemon that will
  // immediately fail on `requireConfig`.
  requireConfig(await loadConfig());

  // Use process.execPath instead of `which node` so the exact Node binary
  // that is currently running is used, regardless of shell PATH.
  const node = process.execPath;
  const script = findBin();
  const log = logPath();
  const plist = buildPlist(node, script, log);
  const target = plistPath();

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.mkdir(path.dirname(log), { recursive: true });
  await fs.writeFile(target, plist, 'utf8');

  // bootout first so re-installs pick up new args/paths.
  spawnSync('launchctl', ['bootout', `gui/${process.getuid?.() ?? ''}`, target], {
    stdio: 'ignore',
  });
  const bootstrap = spawnSync(
    'launchctl',
    ['bootstrap', `gui/${process.getuid?.() ?? ''}`, target],
    { encoding: 'utf8' },
  );

  if (bootstrap.status !== 0) {
    // Fall back to legacy load if bootstrap is unavailable.
    const load = spawnSync('launchctl', ['load', target], { encoding: 'utf8' });
    if (load.status !== 0) {
      return {
        ok: false,
        message: `Failed to register LaunchAgent: ${bootstrap.stderr || load.stderr}`,
      };
    }
  }

  return {
    ok: true,
    message: [
      `Installed LaunchAgent: ${target}`,
      `Logs: ${log}`,
      `Use 'launchctl print gui/$(id -u)/${LABEL}' to inspect.`,
    ].join('\n'),
  };
}

export async function uninstall(): Promise<{ ok: boolean; message: string }> {
  const target = plistPath();
  spawnSync('launchctl', ['bootout', `gui/${process.getuid?.() ?? ''}`, target], {
    stdio: 'ignore',
  });
  spawnSync('launchctl', ['unload', target], { stdio: 'ignore' });
  try {
    await fs.unlink(target);
    return { ok: true, message: `Removed LaunchAgent: ${target}` };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, message: 'LaunchAgent was not installed.' };
    }
    throw err;
  }
}

export async function status(): Promise<{ ok: boolean; message: string }> {
  const target = plistPath();
  const res = spawnSync(
    'launchctl',
    ['print', `gui/${process.getuid?.() ?? ''}/${LABEL}`],
    { encoding: 'utf8' },
  );
  if (res.status === 0) {
    return { ok: true, message: res.stdout.trim() };
  }
  try {
    await fs.access(target);
    return { ok: false, message: 'LaunchAgent plist exists but service is not loaded.' };
  } catch {
    return { ok: false, message: 'LaunchAgent is not installed.' };
  }
}
