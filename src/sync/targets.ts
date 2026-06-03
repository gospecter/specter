/**
 * Per-target vault layout helpers.
 *
 * EVERY target's posts live under its own handle-named folder, regardless of
 * how many targets are configured. This keeps a single-target vault and a
 * multi-target vault laid out the same way, so connecting a second CMS never
 * relocates the first one's files (the v0.3.x "single target at vault root"
 * behavior caused exactly that confusion). Legacy single-target vaults are
 * brought up to this layout once by `migrateVaultLayout` (src/sync/migrate.ts).
 */

import path from 'node:path';
import { TargetConfig } from '../config.js';
import { GhostSyncSettings } from '../types.js';
import { normalizePath } from '../vault.js';

/**
 * The vault-root-relative folder a target's posts live under: always
 * `handle/syncFolderPath` (or just `handle` when no subfolder is set). The
 * handle namespace is what lets multiple CMSes co-exist in one vault and is
 * applied uniformly so the layout is independent of target count.
 *
 * `legacyRoot` computes the OLD (pre-namespacing) location and exists only for
 * the one-time migration, which needs to know where files used to live.
 */
export function effectiveRoot(target: TargetConfig): string {
  const sub = normalizePath(target.syncFolderPath ?? '');
  const handle = target.handle;
  return sub ? `${handle}/${sub}` : handle;
}

/**
 * Where a target's files lived under the pre-v0.6 layout, given whether the
 * config was multi-target at the time. Single-target configs stored files at
 * the bare `syncFolderPath` (often the vault root); multi-target configs were
 * already namespaced. Used only by the layout migration.
 */
export function legacyRoot(target: TargetConfig, wasMulti: boolean): string {
  const sub = normalizePath(target.syncFolderPath ?? '');
  if (!wasMulti) return sub;
  const handle = target.handle;
  return sub ? `${handle}/${sub}` : handle;
}

/**
 * Project a TargetConfig into the per-engine settings shape. The engine reads
 * `syncFolderPath`, `pullDrafts`, `pullPublished`, `conflictStrategy`,
 * `syncMode` — fill those from the target. `ghostUrl`/`adminApiKey` are
 * present only because the legacy GhostSyncSettings interface still includes
 * them; they go unused by the engine now that the adapter is injected.
 */
export function targetSyncSettings(
  target: TargetConfig,
): GhostSyncSettings {
  return {
    ghostUrl: '',
    adminApiKey: '',
    syncFolderPath: effectiveRoot(target),
    pullDrafts: target.pullDrafts,
    pullPublished: target.pullPublished,
    conflictStrategy: target.conflictStrategy,
    syncMode: target.syncMode,
    // Default to posts-only if a target somehow reaches the engine without a
    // normalized kind list (loadConfig backfills, so this is belt-and-braces).
    contentKinds: target.contentKinds ?? ['post'],
  };
}

/**
 * Match a vault-relative path to whichever target's effective root it lives
 * under. Longest-prefix wins, so a target rooted at `blog/posts` beats one
 * rooted at `blog`. Returns null if the path is outside every target's tree.
 *
 * The `relPath` argument is vault-root-relative, forward-slash-separated.
 */
export function routeToTarget(
  relPath: string,
  targets: TargetConfig[],
): TargetConfig | null {
  const norm = normalizePath(relPath);
  const ranked = targets
    .map((t) => ({ target: t, root: effectiveRoot(t) }))
    .sort((a, b) => b.root.length - a.root.length);
  for (const { target, root } of ranked) {
    if (root === '') return target;
    if (norm === root || norm.startsWith(root + '/')) return target;
  }
  return null;
}

/**
 * Absolute path version of `routeToTarget`. Returns the target plus the
 * vault-relative path. Returns null if `absPath` is outside `vaultRoot`.
 */
export function routeAbsoluteToTarget(
  absPath: string,
  vaultRoot: string,
  targets: TargetConfig[],
): { target: TargetConfig; relPath: string } | null {
  const resolvedRoot = path.resolve(vaultRoot);
  const resolved = path.resolve(absPath);
  if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
    return null;
  }
  const rel = path.relative(resolvedRoot, resolved).split(path.sep).join('/');
  const target = routeToTarget(rel, targets);
  return target ? { target, relPath: rel } : null;
}
