/**
 * Per-target vault layout helpers.
 *
 * Single-target configs (every shipped Ghost user after the auto-synthesis)
 * keep using the legacy `syncFolderPath` directly — no extra folder level.
 * Multi-target configs prefix each target's effective root with the target
 * handle so two CMSes can share one vault without colliding.
 */

import path from 'node:path';
import { TargetConfig } from '../config.js';
import { GhostSyncSettings } from '../types.js';
import { normalizePath } from '../vault.js';

/**
 * The vault-root-relative folder a target's posts live under.
 *
 * - Single target: `syncFolderPath` exactly (back-compat with v0.3.x).
 * - Multi target:  `handle/syncFolderPath` (or just `handle` if no subfolder).
 *
 * The handle namespace is what lets two CMSes co-exist in one vault. We do
 * NOT include the handle for single-target configs — that would silently
 * relocate every shipped user's existing files.
 */
export function effectiveRoot(target: TargetConfig, isMulti: boolean): string {
  const sub = normalizePath(target.syncFolderPath ?? '');
  if (!isMulti) return sub;
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
  isMulti: boolean,
): GhostSyncSettings {
  return {
    ghostUrl: '',
    adminApiKey: '',
    syncFolderPath: effectiveRoot(target, isMulti),
    pullDrafts: target.pullDrafts,
    pullPublished: target.pullPublished,
    conflictStrategy: target.conflictStrategy,
    syncMode: target.syncMode,
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
  isMulti: boolean,
): TargetConfig | null {
  const norm = normalizePath(relPath);
  const ranked = targets
    .map((t) => ({ target: t, root: effectiveRoot(t, isMulti) }))
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
  isMulti: boolean,
): { target: TargetConfig; relPath: string } | null {
  const resolvedRoot = path.resolve(vaultRoot);
  const resolved = path.resolve(absPath);
  if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
    return null;
  }
  const rel = path.relative(resolvedRoot, resolved).split(path.sep).join('/');
  const target = routeToTarget(rel, targets, isMulti);
  return target ? { target, relPath: rel } : null;
}
