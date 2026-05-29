import { createAdapter } from '../cms/index.js';
import { loadConfig, loadState, requireConfig, saveState } from '../config.js';
import { SyncEngine } from '../sync/engine.js';
import { ConflictResolution } from '../sync/conflict.js';
import { targetSyncSettings } from '../sync/targets.js';
import { Vault } from '../vault.js';

interface ResolveOptions {
  id?: string;
  keep?: 'local' | 'remote';
}

export async function resolveCommand(options: ResolveOptions): Promise<void> {
  if (!options.id) throw new Error('Missing required --id <conflict_id>');
  if (options.keep !== 'local' && options.keep !== 'remote') {
    throw new Error('Missing required --keep <local|remote>');
  }

  const config = requireConfig(await loadConfig());
  const state = await loadState();
  const conflict = state.conflicts.find((item) => item.id === options.id);
  if (!conflict) throw new Error(`No queued conflict found for id: ${options.id}`);

  // Pre-v0.4.0 conflicts have no targetHandle — fall back to targets[0],
  // which for shipped Ghost users is the auto-synthesized Ghost target.
  const target =
    config.targets.find((t) => t.handle === conflict.targetHandle) ?? config.targets[0];
  if (!target) {
    throw new Error(
      `Cannot resolve conflict ${options.id}: no matching target ${
        conflict.targetHandle ? `'${conflict.targetHandle}'` : ''
      } in config.`,
    );
  }

  const vault = new Vault(config.vaultPath);
  const adapter = createAdapter(target.adapter);
  const settings = targetSyncSettings(target, config.targets.length > 1);
  const engine = new SyncEngine(vault, adapter, settings);
  const resolution: ConflictResolution = options.keep === 'local' ? 'keep_local' : 'keep_remote';

  await engine.resolveConflict(conflict, resolution);

  const nextConflicts = state.conflicts.filter((item) => item.id !== options.id);
  await saveState({
    ...state,
    lastSyncAt: new Date().toISOString(),
    lastSyncStatus: nextConflicts.length > 0 ? 'conflict' : 'ok',
    lastSyncMessage: `resolved conflict for ${conflict.localPost.title || conflict.localPost.file.basename}`,
    lastConflicts: nextConflicts.length,
    conflicts: nextConflicts,
  });

  console.log(`[ghost-sync] resolved ${options.id} with ${options.keep}`);
}
