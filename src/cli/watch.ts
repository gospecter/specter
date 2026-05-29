import path from 'node:path';
import chokidar from 'chokidar';
import { createAdapter } from '../cms/index.js';
import { SyncEngine } from '../sync/engine.js';
import { effectiveRoot, routeAbsoluteToTarget, targetSyncSettings } from '../sync/targets.js';
import { Vault } from '../vault.js';
import {
  TargetConfig,
  loadConfig,
  requireConfig,
  saveState,
  loadState,
  QueuedConflict,
} from '../config.js';
import { notify } from '../notify.js';
import { ConflictItem } from '../types.js';
import { runOnce } from './run.js';
import { LicenseLimitError, assertCanSync, recordSync } from '../license/gate.js';
import { revalidateInternal } from './license.js';

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
  const vault = new Vault(config.vaultPath);
  const isMulti = config.targets.length > 1;

  const runtimes: TargetRuntime[] = config.targets.map((target) => {
    const settings = targetSyncSettings(target, isMulti);
    const adapter = createAdapter(target.adapter);
    const engine = new SyncEngine(vault, adapter, settings);
    const absRoot = path.resolve(config.vaultPath, effectiveRoot(target, isMulti));
    return { target, engine, absRoot };
  });

  const intervalMs = Math.max(1, parseInt(options.interval, 10)) * 60 * 1000;
  // In manual mode no target pushes on its own. We still poll for remote
  // changes per-target so local copies don't drift. If targets disagree on
  // mode, treat any 'manual' as "skip pushes for that target" rather than
  // forcing one mode globally.
  const anyAuto = runtimes.some((r) => r.target.syncMode === 'auto');

  for (const { target, absRoot } of runtimes) {
    console.log(`[ghost-sync] [${target.handle}] watching ${absRoot} (mode=${target.syncMode})`);
  }
  console.log(
    `[ghost-sync] periodic ${anyAuto ? 'full sync' : 'pull'} every ${options.interval}m`,
  );

  // Initial reconciliation. runOnce iterates all targets internally.
  try {
    await runOnce(anyAuto ? 'sync' : 'pull', true);
  } catch (err) {
    console.error(`[ghost-sync] initial sync failed:`, err);
  }

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
        isMulti,
      );
      if (!route) continue;
      const runtime = runtimes.find((r) => r.target.handle === route.target.handle);
      if (!runtime) continue;
      if (runtime.target.syncMode === 'manual') continue;

      const file = await vault.fromAbsolute(absPath);
      if (!file) continue;
      if (!runtime.engine.isInSyncFolder(file)) continue;

      // Per-file push = +1 against the shared free-tier cap.
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

  // Periodic reconciliation. runOnce handles per-target mode internally
  // (auto targets sync; manual targets only pull).
  const periodic = setInterval(() => {
    runOnce(anyAuto ? 'sync' : 'pull', true).catch((err) =>
      console.error('[ghost-sync] periodic sync failed:', err),
    );
  }, intervalMs);

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
    clearInterval(periodic);
    clearInterval(revalidate);
    if (timer) clearTimeout(timer);
    await flush();
    await Promise.all(watchers.map((w) => w.close()));
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
