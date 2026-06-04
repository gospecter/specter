import { describe, it, expect } from 'vitest';
import {
  acquireSingleInstanceLock,
  type LockDeps,
} from '../../src/daemon/single-instance.js';

/** In-memory test harness for the lock's injected dependencies. */
function makeDeps(opts: {
  selfPid: number;
  existingPid?: number | null;
  alivePids: Set<number>;
  /** PIDs that ignore SIGTERM (stay alive until SIGKILL). */
  ignoresSigterm?: Set<number>;
}) {
  const store = new Map<string, number>();
  if (opts.existingPid != null) store.set('lock', opts.existingPid);
  const ignoresSigterm = opts.ignoresSigterm ?? new Set<number>();
  const signals: Array<{ pid: number; signal: string }> = [];
  let clock = 1000;

  const deps: LockDeps = {
    readPid: () => store.get('lock') ?? null,
    writePid: (_p, pid) => void store.set('lock', pid),
    removePid: () => void store.delete('lock'),
    isAlive: (pid) => opts.alivePids.has(pid),
    kill: (pid, signal) => {
      signals.push({ pid, signal });
      if (signal === 'SIGKILL') opts.alivePids.delete(pid);
      if (signal === 'SIGTERM' && !ignoresSigterm.has(pid)) opts.alivePids.delete(pid);
    },
    now: () => clock,
    // Advancing the clock on each sleep lets the grace loop terminate.
    sleep: async (ms) => {
      clock += ms;
    },
    selfPid: opts.selfPid,
  };
  return { deps, store, signals };
}

describe('acquireSingleInstanceLock', () => {
  it('supersedes a live prior daemon with SIGTERM, then takes the lock', async () => {
    const { deps, store, signals } = makeDeps({
      selfPid: 200,
      existingPid: 100,
      alivePids: new Set([100]),
    });
    const release = await acquireSingleInstanceLock('lock', deps, { graceMs: 3000, pollMs: 100 });

    expect(signals).toContainEqual({ pid: 100, signal: 'SIGTERM' });
    expect(signals.find((s) => s.signal === 'SIGKILL')).toBeUndefined();
    expect(store.get('lock')).toBe(200); // ownership transferred
    release();
    expect(store.has('lock')).toBe(false);
  });

  it('escalates to SIGKILL when the prior daemon ignores SIGTERM', async () => {
    const { deps, signals, store } = makeDeps({
      selfPid: 200,
      existingPid: 100,
      alivePids: new Set([100]),
      ignoresSigterm: new Set([100]),
    });
    await acquireSingleInstanceLock('lock', deps, { graceMs: 500, pollMs: 100 });

    expect(signals).toContainEqual({ pid: 100, signal: 'SIGTERM' });
    expect(signals).toContainEqual({ pid: 100, signal: 'SIGKILL' });
    expect(store.get('lock')).toBe(200);
  });

  it('never signals itself (idempotent re-acquire)', async () => {
    const { deps, signals, store } = makeDeps({
      selfPid: 100,
      existingPid: 100,
      alivePids: new Set([100]),
    });
    await acquireSingleInstanceLock('lock', deps);
    expect(signals).toHaveLength(0);
    expect(store.get('lock')).toBe(100);
  });

  it('does not signal a stale (dead) holder, just claims the lock', async () => {
    const { deps, signals, store } = makeDeps({
      selfPid: 200,
      existingPid: 100,
      alivePids: new Set(), // 100 is dead
    });
    await acquireSingleInstanceLock('lock', deps);
    expect(signals).toHaveLength(0);
    expect(store.get('lock')).toBe(200);
  });

  it('claims an empty lock with no signals', async () => {
    const { deps, signals, store } = makeDeps({
      selfPid: 200,
      existingPid: null,
      alivePids: new Set(),
    });
    await acquireSingleInstanceLock('lock', deps);
    expect(signals).toHaveLength(0);
    expect(store.get('lock')).toBe(200);
  });

  it('release does NOT delete a successor lock', async () => {
    const { deps, store } = makeDeps({
      selfPid: 200,
      existingPid: null,
      alivePids: new Set(),
    });
    const release = await acquireSingleInstanceLock('lock', deps);
    store.set('lock', 999); // a newer daemon superseded us
    release();
    expect(store.get('lock')).toBe(999); // untouched
  });
});
