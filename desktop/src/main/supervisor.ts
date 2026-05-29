/**
 * DaemonSupervisor — mirrors mac/Sources/Specter/DaemonSupervisor.swift.
 *
 * Spawns the daemon as an ELECTRON_RUN_AS_NODE=1 child process, so Electron's
 * own bundled Node runtime executes daemon.bundle.js without needing a
 * separate node binary on the user's PATH.
 *
 * Restart policy (matches the Swift implementation):
 *   - Clean exit (code 0): intentional stop — do NOT restart.
 *   - Non-zero exit: exponential back-off starting at 2s, capped at 30s.
 *   - More than 5 crashes in 60s: stop restarting, log the error.
 *
 * Logs are appended to the same path the daemon's logPath() would compute
 * (see paths.ts) so the tray's "View Logs" entry shows live daemon output.
 */

import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { daemonBundlePath, logFilePath } from './paths.js';

export type SupervisorStatus = 'running' | 'stopped' | 'crashed';

export class DaemonSupervisor extends EventEmitter {
  private child: ChildProcess | null = null;
  private intentionalStop = false;
  private restartCount = 0;
  private restartWindowStart = 0;
  private backoffMs = 2000;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  private _status: SupervisorStatus = 'stopped';
  private _lastError: string | null = null;

  get status(): SupervisorStatus {
    return this._status;
  }

  get isRunning(): boolean {
    return this._status === 'running';
  }

  get lastError(): string | null {
    return this._lastError;
  }

  /** Start the daemon. Idempotent — calling while running is a no-op. */
  start(): void {
    if (this._status === 'running') return;
    this.intentionalStop = false;
    this._lastError = null;
    this.spawn();
  }

  /** Stop the daemon cleanly. Sets intentionalStop so no restart occurs. */
  stop(): void {
    this.intentionalStop = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (!this.child) {
      this.setStatus('stopped');
      return;
    }
    this.child.kill('SIGTERM');
    // Grace period before SIGKILL
    const child = this.child;
    setTimeout(() => {
      if (child.exitCode === null) {
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
      }
    }, 500);
  }

  /** Restart. Used after settings save. */
  restart(): void {
    this.stop();
    setTimeout(() => {
      this.intentionalStop = false;
      this.start();
    }, 700);
  }

  private spawn(): void {
    const bundle = daemonBundlePath();

    // Ensure log directory exists.
    const logFile = logFilePath();
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
    } catch { /* ignore */ }

    let logFd: number | undefined;
    try {
      logFd = fs.openSync(logFile, 'a');
    } catch { /* non-fatal; daemon will still run */ }

    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
    };

    // process.execPath is the Electron binary; ELECTRON_RUN_AS_NODE=1 makes
    // it behave as a plain Node.js process.
    this.child = spawn(process.execPath, [bundle, 'watch'], {
      env,
      stdio: logFd !== undefined ? ['ignore', logFd, logFd] : ['ignore', 'pipe', 'pipe'],
    });

    if (logFd !== undefined) {
      // Close our copy of the fd — the child holds its own reference.
      try { fs.closeSync(logFd); } catch { /* ignore */ }
    } else if (this.child.stdout && this.child.stderr) {
      // Fallback: pipe to our own stdout so output isn't lost in dev.
      this.child.stdout.pipe(process.stdout);
      this.child.stderr.pipe(process.stderr);
    }

    this.setStatus('running');

    this.child.on('exit', (code, signal) => {
      this.child = null;
      this.handleExit(code, signal);
    });

    this.child.on('error', (err) => {
      this._lastError = err.message;
      this.setStatus('crashed');
    });
  }

  private handleExit(code: number | null, signal: string | null): void {
    if (this.intentionalStop || code === 0) {
      this.setStatus('stopped');
      return;
    }

    // Rate-limit restarts.
    const now = Date.now();
    if (now - this.restartWindowStart > 60_000) {
      this.restartWindowStart = now;
      this.restartCount = 0;
      this.backoffMs = 2000;
    }

    this.restartCount++;
    if (this.restartCount > 5) {
      this._lastError = `Daemon crashed ${this.restartCount} times in 60s — stopped restarting. Check the logs.`;
      this.setStatus('crashed');
      this.emit('crash-loop', this._lastError);
      return;
    }

    // Exponential back-off capped at 30s.
    const delay = Math.min(this.backoffMs, 30_000);
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    this.setStatus('stopped');

    this.restartTimer = setTimeout(() => {
      if (!this.intentionalStop) this.spawn();
    }, delay);
  }

  private setStatus(s: SupervisorStatus): void {
    this._status = s;
    this.emit('status-change', s);
  }
}
