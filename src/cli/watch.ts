import path from 'node:path';
import chokidar from 'chokidar';
import { createAdapter } from '../cms/index.js';
import { SyncEngine } from '../sync/engine.js';
import {
  effectiveRoot,
  routeAbsoluteToTarget,
  targetSyncSettings,
  autoReconcileHandles,
} from '../sync/targets.js';
import { migrateVaultLayout } from '../sync/migrate.js';
import { Vault } from '../vault.js';
import {
  TargetConfig,
  loadConfig,
  requireConfig,
  saveState,
  loadState,
  stateDir,
  QueuedConflict,
} from '../config.js';
import { notify } from '../notify.js';
import { ConflictItem } from '../types.js';
import { runOnce } from './run.js';
import { LicenseLimitError, assertCanSync, recordSync } from '../license/gate.js';
import { revalidateInternal } from './license.js';
import { acquireSingleInstanceLock, realLockDeps } from '../daemon/single-instance.js';

interface WatchOptions {
  interval: string;
}

interface TargetRuntime {
  target: TargetConfig;
  engine: SyncEngine;
  absRoot: string;
}

export async function watchCommand(options: WatchOptions): Promise<void> {
  const config = requireConfig(await loadConfig());

  // Single-instance guard: a starting daemon supersedes any stale/orphaned one
  // so multiple daemons can't pile up (e.g. after a force-quit) and fight over
  // state.json. Released on clean shutdown.
  const releaseLock = await acquireSingleInstanceLock(
    path.join(stateDir(), 'daemon.pid'),
    realLockDeps(),
  );

  const vault = new Vault(config.vaultPath);

  // One-time vault layout migration: pre-v0.6 single-target vaults kept files
  // at the bare syncFolderPath; every target is now namespaced under its
  // handle. Runs before we build runtimes so the watcher points at the new
  // locations. No-op once the config is stamped `vaultLayout: 'namespaced'`.
  let migrationOk = true;
  try {
    await migrateVaultLayout(config, { log: (m) => console.log(`[ghost-sync] ${m}`) });
  } catch (err) {
    migrationOk = false;
    console.error('[ghost-sync] vault layout migration failed:', err);
    console.error(
      '[ghost-sync] automatic sync is paused until this is resolved — files still live at their old ' +
        'location while Specter now expects them under each connection\'s folder. Resolve the conflict ' +
        'above (or run `ghost-sync migrate`) and restart.',
    );
  }

  const runtimes: TargetRuntime[] = config.targets.map((target) => {
    const settings = targetSyncSettings(target);
    const adapter = createAdapter(target.adapter);
    const engine = new SyncEngine(vault, adapter, settings);
    const absRoot = path.resolve(config.vaultPath, effectiveRoot(target));
    return { target, engine, absRoot };
  });

  const intervalMs = Math.max(1, parseInt(options.interval, 10)) * 60 * 1000;

  // Reconciliation is per-target and honors each target's syncMode. Auto
  // targets get a full bi-directional sync; manual targets are NEVER pulled or
  // pushed automatically — not on startup, not on the periodic tick. "Manual
  // only" means the user drives every sync explicitly (menu / dashboard / CLI),
  // so connecting a manual target no longer triggers a surprise pull.
  const autoHandles = autoReconcileHandles(runtimes.map((r) => r.target));

  const reconcile = async (label: string): Promise<void> => {
    // A failed layout migration means files may still sit at their old paths
    // while the engine now looks under handle folders — auto-pulling would
    // create duplicates. Stay hands-off until the user resolves it.
    if (!migrationOk) return;
    for (const handle of autoHandles) {
      try {
        await runOnce('sync', { target: handle, silent: true });
      } catch (err) {
        console.error(`[ghost-sync] ${label} sync failed for [${handle}]:`, err);
      }
    }
  };

  for (const { target, absRoot } of runtimes) {
    console.log(`[ghost-sync] [${target.handle}] watching ${absRoot} (mode=${target.syncMode})`);
  }
  if (autoHandles.length > 0) {
    console.log(
      `[ghost-sync] periodic full sync every ${options.interval}m for: ${autoHandles.join(', ')}`,
    );
  } else {
    console.log('[ghost-sync] all targets manual — no automatic reconciliation; sync on demand');
  }

  // Initial reconciliation (auto targets only).
  await reconcile('initial');

  const pending = new Set<string>();
  let timer: NodeJS.Timeout | null = null;

  const flush = async () => {
    if (pending.size === 0) return;
    const toPush = Array.from(pending);
    pending.clear();

    for (const absPath of toPush) {
      const route = routeAbsoluteToTarget(
        absPath,
        config.vaultPath,
        config.targets,
      );
      if (!route) continue;
      const runtime = runtimes.find((r) => r.target.handle === route.target.handle);
      if (!runtime) continue;
      if (runtime.target.syncMode === 'manual') continue;

      const file = await vault.fromAbsolute(absPath);
      if (!file) continue;
      if (!runtime.engine.isInSyncFolder(file)) continue;

      // Per-file push = +1 against the shared upload gate.
      try {
        await assertCanSync(1);
      } catch (err) {
        if (err instanceof LicenseLimitError) {
          notify('Specter — Free limit reached', err.message);
          await markRecent(err.message, 'error');
          return;
        }
        throw err;
      }

      try {
        const result = await runtime.engine.pushFile(file);
        if (result.success) {
          await recordSync(1);
          notify('Specter', `Pushed ${file.basename}`);
          await markRecent(`pushed ${file.basename}`);
        } else if (result.conflict) {
          notify('Specter conflict', `${file.basename} — open dialog to resolve`);
          await markRecent(
            `conflict ${file.basename}`,
            'conflict',
            result.conflict,
            runtime.target.handle,
          );
        } else if (result.error) {
          notify('Specter error', `${file.basename}: ${result.error}`);
          await markRecent(`error ${file.basename}: ${result.error}`, 'error');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        notify('Specter error', `${file.basename}: ${msg}`);
        await markRecent(`error ${file.basename}: ${msg}`, 'error');
      }
    }
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      flush().catch((err) => console.error('[ghost-sync] flush error:', err));
    }, config.watchDebounceMs);
  };

  // One chokidar watcher per target root. Cleaner than a vault-root watcher
  // because chokidar's ready/initial-scan accounting stays per-target, and
  // the kernel watch budget scales with what we actually care about.
  const watchers = runtimes.map(({ absRoot }) =>
    chokidar.watch(absRoot, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 100 },
      ignored: /(^|[\\/])\.[^/\\]+/,
    }),
  );

  for (const watcher of watchers) {
    watcher
      .on('add', (p) => {
        if (p.endsWith('.md')) {
          pending.add(p);
          schedule();
        }
      })
      .on('change', (p) => {
        if (p.endsWith('.md')) {
          pending.add(p);
          schedule();
        }
      })
      .on('error', (err) => console.error('[ghost-sync] watcher error:', err));
  }

  // Periodic reconciliation — auto targets only (see `reconcile`). Skipped
  // entirely when no target is in auto mode.
  const periodic = autoHandles.length
    ? setInterval(() => {
        reconcile('periodic').catch((err) =>
          console.error('[ghost-sync] periodic sync failed:', err),
        );
      }, intervalMs)
    : null;

  // Daily license re-validation.
  const revalidate = setInterval(() => {
    revalidateInternal().catch((err) =>
      console.error('[ghost-sync] license revalidation failed:', err),
    );
  }, 24 * 60 * 60 * 1000);
  setTimeout(() => {
    revalidateInternal().catch(() => undefined);
  }, 60 * 1000);

  const shutdown = async () => {
    if (periodic) clearInterval(periodic);
    clearInterval(revalidate);
    if (timer) clearTimeout(timer);
    await flush();
    await Promise.all(watchers.map((w) => w.close()));
    releaseLock();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function markRecent(
  message: string,
  status: 'ok' | 'error' | 'conflict' = 'ok',
  conflict?: ConflictItem,
  targetHandle?: string,
): Promise<void> {
  const prior = await loadState();
  const conflicts = conflict
    ? queueConflicts(prior.conflicts, [conflict], targetHandle)
    : prior.conflicts;
  await saveState({
    ...prior,
    lastSyncAt: new Date().toISOString(),
    lastSyncStatus: status,
    lastSyncMessage: message,
    conflicts,
  });
}

function queueConflicts(
  existing: QueuedConflict[],
  conflicts: ConflictItem[],
  targetHandle?: string,
): QueuedConflict[] {
  const queued = [...existing];
  const seen = new Set(queued.map(conflictKey));
  for (const conflict of conflicts) {
    const id = conflictKey(conflict);
    if (seen.has(id)) continue;
    queued.push({
      ...conflict,
      id,
      createdAt: new Date().toISOString(),
      targetHandle,
    });
    seen.add(id);
  }
  return queued;
}

function conflictKey(conflict: ConflictItem): string {
  return conflict.localPost.frontmatter.ghost_id || conflict.ghostPost?.id || conflict.localPost.file.path;
}
