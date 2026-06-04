/**
 * Single-instance guard for the `watch` daemon.
 *
 * The desktop shells spawn `node daemon.mjs watch` as a child. If the app is
 * force-quit or crashes, macOS does NOT reap that child — it orphans and keeps
 * running. Every subsequent launch spawns another, so orphaned daemons pile up
 * across sessions and all write to the same `state.json` (observed: 5 leaked
 * instances stamping syncs on manual targets). The app's intent is exactly ONE
 * daemon, so a starting daemon must supersede any stale one.
 *
 * The core logic is pure and dependency-injected so it can be unit-tested
 * without touching real processes or the filesystem. `realLockDeps()` wires it
 * to `node:fs` + `process` for production.
 */

import fs from 'node:fs';

export interface LockDeps {
  /** Read the PID written in the lockfile; null if absent or unparseable. */
  readPid: (pidPath: string) => number | null;
  writePid: (pidPath: string, pid: number) => void;
  removePid: (pidPath: string) => void;
  /** Is a process with this PID currently alive? */
  isAlive: (pid: number) => boolean;
  /** Send a signal to a PID (SIGTERM then SIGKILL as a fallback). */
  kill: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** This process's own PID. */
  selfPid: number;
  /** Optional progress log. */
  log?: (msg: string) => void;
}

export interface LockOptions {
  /** How long to wait for a superseded daemon to exit before SIGKILL. */
  graceMs?: number;
  pollMs?: number;
}

/**
 * Acquire the single-instance lock. If a *different*, still-alive daemon holds
 * it, terminate that daemon (SIGTERM, then SIGKILL after a grace period) and
 * take ownership. Returns a `release` function that clears the lockfile — but
 * only if we still own it, so a daemon we superseded can't delete our lock on
 * its way out.
 */
export async function acquireSingleInstanceLock(
  pidPath: string,
  deps: LockDeps,
  opts: LockOptions = {},
): Promise<() => void> {
  const graceMs = opts.graceMs ?? 3000;
  const pollMs = opts.pollMs ?? 100;

  const existing = deps.readPid(pidPath);
  if (existing !== null && existing !== deps.selfPid && deps.isAlive(existing)) {
    deps.log?.(`superseding existing daemon (pid ${existing})`);
    try {
      deps.kill(existing, 'SIGTERM');
    } catch {
      // Already gone between the isAlive check and the signal — fine.
    }
    const deadline = deps.now() + graceMs;
    while (deps.isAlive(existing) && deps.now() < deadline) {
      await deps.sleep(pollMs);
    }
    if (deps.isAlive(existing)) {
      deps.log?.(`pid ${existing} ignored SIGTERM — sending SIGKILL`);
      try {
        deps.kill(existing, 'SIGKILL');
      } catch {
        // Raced to exit — fine.
      }
    }
  }

  deps.writePid(pidPath, deps.selfPid);

  return () => {
    // Only clear the lock if it's still ours — never delete a successor's lock.
    if (deps.readPid(pidPath) === deps.selfPid) {
      deps.removePid(pidPath);
    }
  };
}

/** Production dependencies: real filesystem + `process` signals. */
export function realLockDeps(): LockDeps {
  return {
    readPid: (pidPath) => {
      try {
        const raw = fs.readFileSync(pidPath, 'utf8').trim();
        const pid = Number.parseInt(raw, 10);
        return Number.isInteger(pid) && pid > 0 ? pid : null;
      } catch {
        return null;
      }
    },
    writePid: (pidPath, pid) => {
      fs.writeFileSync(pidPath, String(pid), 'utf8');
    },
    removePid: (pidPath) => {
      try {
        fs.unlinkSync(pidPath);
      } catch {
        // Already gone — fine.
      }
    },
    // `kill(pid, 0)` throws ESRCH if the process doesn't exist, EPERM if it
    // exists but we can't signal it (still "alive" for our purposes).
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
      }
    },
    kill: (pid, signal) => process.kill(pid, signal),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    selfPid: process.pid,
    log: (msg) => console.log(`[ghost-sync] ${msg}`),
  };
}
