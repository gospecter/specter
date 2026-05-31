/**
 * Reads and writes the daemon's config.json.
 * Shape mirrors src/config.ts DaemonConfig + GhostSyncSettings + TargetConfig.
 *
 * v0.4.0: gained `targets[]`. v0.6.x: the Electron UI is fully multi-target —
 * it adds unlimited targets of any platform via `upsertGhostTarget` /
 * `upsertWordPressTarget` / `upsertShopifyTarget`, each with a unique slugified
 * handle and its own per-handle sync folder. `writeConfig` is NON-DESTRUCTIVE:
 * it preserves every target verbatim (see `mergeTargetsForConfig`) and only
 * synthesizes a single `handle:'ghost'` target on the empty-targets first run.
 * The legacy flat fields are kept as a mirror of `targets[0]` so the old
 * single-Ghost Settings window still round-trips.
 */

import fs from 'fs';
import path from 'path';
import { configFilePath, configDir } from './paths.js';
import {
  mergeTargetsForConfig,
  normalizeContentKinds,
  baseKind,
  PLATFORM_KINDS,
  slugifyHandle,
  uniqueHandle,
  type AdapterConfig,
  type AppConfig,
  type ContentKind,
  type Platform,
  type TargetConfig,
} from './config-merge.js';

export { mergeTargetsForConfig, normalizeContentKinds, baseKind };
export type { AdapterConfig, AppConfig, ContentKind, Platform, TargetConfig };

const DEFAULTS: AppConfig = {
  ghostUrl: '',
  adminApiKey: '',
  vaultPath: '',
  syncFolderPath: '',
  pullDrafts: true,
  pullPublished: true,
  conflictStrategy: 'ask',
  syncMode: 'auto',
  watchDebounceMs: 2000,
};

export function configExists(): boolean {
  try {
    fs.accessSync(configFilePath(), fs.constants.R_OK);
    const raw = fs.readFileSync(configFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    // Either legacy creds OR a configured target counts as "has config".
    const hasLegacy = !!(parsed.ghostUrl && parsed.adminApiKey);
    const hasTargets = !!(parsed.targets && parsed.targets.length > 0);
    return !!(parsed.vaultPath && (hasLegacy || hasTargets));
  } catch {
    return false;
  }
}

export function readConfig(): AppConfig | null {
  try {
    const raw = fs.readFileSync(configFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    const merged = { ...DEFAULTS, ...parsed };
    // Normalize each target's contentKinds for display: a legacy target with no
    // `contentKinds` shows the platform's base kind (mirroring the daemon's
    // backfill), and a present list is filtered to the platform's supported set.
    if (merged.targets && merged.targets.length > 0) {
      merged.targets = merged.targets.map((t) => ({
        ...t,
        contentKinds: normalizeContentKinds(t),
      }));
    }
    // Project targets[0] back onto legacy fields so the UI shows the right
    // values even if the user hasn't re-saved since v0.4.0.
    const first = merged.targets?.[0];
    if (first && first.adapter.platform === 'ghost') {
      if (!merged.ghostUrl && first.adapter.ghostUrl) merged.ghostUrl = first.adapter.ghostUrl;
      if (!merged.adminApiKey && first.adapter.adminApiKey)
        merged.adminApiKey = first.adapter.adminApiKey;
      if (!merged.syncFolderPath && first.syncFolderPath)
        merged.syncFolderPath = first.syncFolderPath;
    }
    return merged;
  } catch {
    return null;
  }
}

export function writeConfig(cfg: AppConfig): void {
  fs.mkdirSync(configDir(), { recursive: true });

  // Two callers, two contracts:
  //
  // 1. The per-platform upsert helpers (Ghost/WordPress/Shopify) pass an
  //    explicit `cfg.targets[]` — that list is already the full, deduped set
  //    and must be written VERBATIM. We never collapse or re-synthesize it.
  //
  // 2. The legacy single-Ghost Settings/onboarding window passes a flat config
  //    with NO `targets` field. It edits the primary Ghost connection, so we
  //    fold the flat Ghost creds into targets[0] (the existing Ghost target, if
  //    any) while PRESERVING targets[1..N] read back from disk. On a truly
  //    empty config this synthesizes the very first Ghost target.
  let targets: TargetConfig[];
  if (cfg.targets && cfg.targets.length > 0) {
    targets = cfg.targets;
  } else {
    const onDisk = readConfig()?.targets ?? [];
    targets = applyLegacyGhostEdit(onDisk, cfg);
  }

  // Keep the legacy flat fields as a faithful mirror of targets[0] so the old
  // single-Ghost Settings window keeps round-tripping. A non-Ghost first target
  // clears the Ghost-specific creds (they no longer describe a live connection)
  // but never drops any target.
  const toWrite: AppConfig = { ...cfg, targets, ...legacyFromTargets(targets) };
  writeConfigAtomic(toWrite);
}

/**
 * Fold the legacy flat Ghost fields into the existing target list, editing the
 * primary Ghost target in place (handle preserved) and keeping every other
 * target. When there's no Ghost target yet, synthesize one via
 * `mergeTargetsForConfig` and append the rest.
 */
function applyLegacyGhostEdit(
  existing: TargetConfig[],
  legacy: AppConfig,
): TargetConfig[] {
  const ghostIdx = existing.findIndex((t) => t.adapter.platform === 'ghost');
  if (ghostIdx >= 0) {
    const next = [...existing];
    const prev = next[ghostIdx];
    next[ghostIdx] = {
      ...prev,
      syncFolderPath: legacy.syncFolderPath,
      pullDrafts: legacy.pullDrafts,
      pullPublished: legacy.pullPublished,
      conflictStrategy: legacy.conflictStrategy,
      syncMode: legacy.syncMode,
      adapter: {
        ...prev.adapter,
        platform: 'ghost',
        ghostUrl: legacy.ghostUrl,
        adminApiKey: legacy.adminApiKey,
      },
    };
    return next;
  }
  // No Ghost target yet: synthesize the first one, then append any existing
  // (non-Ghost) targets so they survive a legacy save.
  const synthesized = mergeTargetsForConfig(undefined, legacy)[0];
  return [synthesized, ...existing];
}

/**
 * Project `targets[0]` back onto the legacy flat fields. Returns only the
 * fields that should mirror the first target so callers can spread it over the
 * config. A Ghost first-target fills ghostUrl/adminApiKey/syncFolderPath; any
 * other platform clears the Ghost-specific creds (the flat fields no longer
 * describe a live Ghost connection) while preserving every target.
 */
function legacyFromTargets(
  targets: TargetConfig[],
): Pick<AppConfig, 'ghostUrl' | 'adminApiKey' | 'syncFolderPath'> {
  const first = targets[0];
  if (first && first.adapter.platform === 'ghost') {
    return {
      ghostUrl: first.adapter.ghostUrl ?? '',
      adminApiKey: first.adapter.adminApiKey ?? '',
      syncFolderPath: first.syncFolderPath ?? '',
    };
  }
  return { ghostUrl: '', adminApiKey: '', syncFolderPath: '' };
}

/**
 * Atomic config write: write to a temp file in the same directory, chmod 600
 * on POSIX, then rename over the target. Rename within the same filesystem is
 * atomic — readers see either the old contents or the new, never a partial.
 *
 * Exported so single-field updaters (e.g. `setTargetSyncMode`) can reuse the
 * exact same on-disk safety contract without duplicating the dance.
 */
export function writeConfigAtomic(cfg: AppConfig): void {
  fs.mkdirSync(configDir(), { recursive: true });
  const finalPath = configFilePath();
  const tempPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  const body = JSON.stringify(cfg, null, 2) + '\n';
  fs.writeFileSync(tempPath, body, 'utf8');
  if (process.platform !== 'win32') {
    try { fs.chmodSync(tempPath, 0o600); } catch { /* ignore */ }
  }
  try {
    fs.renameSync(tempPath, finalPath);
  } catch (err) {
    // Clean up the temp file on rename failure (e.g. cross-filesystem).
    try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    throw err;
  }
  if (process.platform !== 'win32') {
    try { fs.chmodSync(finalPath, 0o600); } catch { /* ignore */ }
  }
}

/**
 * Update a single target's `syncMode` in place. Preserves every other target
 * (and every other field on the touched target) untouched. Writes the config
 * atomically. Returns true on success; false when the handle is unknown.
 *
 * Used by `config:set-target-sync-mode` so the dashboard's per-card Auto toggle
 * persists across daemon restarts and window reloads.
 */
export function setTargetSyncMode(
  handle: string,
  mode: 'auto' | 'manual',
): { ok: true } | { ok: false; error: string } {
  const current = readConfig();
  if (!current) return { ok: false, error: 'No config on disk yet.' };
  const targets = current.targets ?? [];
  const idx = targets.findIndex((t) => t.handle === handle);
  if (idx < 0) return { ok: false, error: `Unknown target: ${handle}` };

  const nextTargets = targets.map((t, i) =>
    i === idx ? { ...t, syncMode: mode } : t,
  );

  // Pass targets through unchanged — we do NOT want mergeTargetsForConfig to
  // re-synthesize targets[0] from the legacy flat fields, because that would
  // overwrite a Ghost target's syncMode we just set. We also keep the
  // top-level legacy `syncMode` aligned when we're touching the Ghost target,
  // so the Settings window stays in sync.
  const nextCfg: AppConfig = { ...current, targets: nextTargets };
  if (targets[idx].adapter.platform === 'ghost') {
    nextCfg.syncMode = mode;
  }

  try {
    writeConfigAtomic(nextCfg);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Update a single target's `contentKinds` in place, filtered to the platform's
 * supported set. Preserves every other target (and every other field on the
 * touched target). Writes the config atomically. An empty array is valid
 * ("sync nothing"). Returns false when the handle is unknown.
 *
 * Used by `config:set-target-content-kinds` so the dashboard can change which
 * kinds a target syncs — notably Shopify, which has no in-app connect form.
 */
export function setTargetContentKinds(
  handle: string,
  contentKinds: ContentKind[],
): { ok: true } | { ok: false; error: string } {
  const current = readConfig();
  if (!current) return { ok: false, error: 'No config on disk yet.' };
  const targets = current.targets ?? [];
  const idx = targets.findIndex((t) => t.handle === handle);
  if (idx < 0) return { ok: false, error: `Unknown target: ${handle}` };

  const supported = PLATFORM_KINDS[targets[idx].adapter.platform];
  const filtered = contentKinds.filter((k) => supported.includes(k));
  const nextTargets = targets.map((t, i) =>
    i === idx ? { ...t, contentKinds: filtered } : t,
  );

  try {
    writeConfigAtomic({ ...current, targets: nextTargets });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Add or update a WordPress target from the connect form. The site URL is
 * normalized (default https://, trailing slashes stripped) before persistence
 * so duplicate-detection (and the per-target folder name) work off a stable
 * hostname.
 */
export function upsertWordPressTarget(
  siteUrl: string,
  username: string,
  appPassword: string,
  label?: string,
  contentKinds?: ContentKind[],
): void {
  const current = readConfig();
  if (!current?.vaultPath) {
    throw new Error('Set up a local sync folder before adding a new site.');
  }

  const normalizedUrl = normalizeWordPressSiteUrl(siteUrl);
  const host = hostnameOf(normalizedUrl) || 'site';

  const targets = current.targets ? [...current.targets] : [];
  const idx = targets.findIndex(
    (existing) =>
      existing.adapter.platform === 'wordpress' &&
      hostnameOf(existing.adapter.siteUrl ?? '') === host,
  );

  // Editing an existing site keeps its handle (and therefore its folder);
  // a brand-new site gets a unique slugified handle so it can never collide
  // with another target's handle or its derived `handle/` sync folder.
  const handle =
    idx >= 0
      ? targets[idx].handle
      : uniqueHandle(slugifyHandle(host || label || 'wordpress'), targets.map((t) => t.handle));

  const target: TargetConfig = {
    handle,
    label: label?.trim() || (idx >= 0 ? targets[idx].label : 'WordPress'),
    // Empty by default → the daemon's effective folder is the handle itself,
    // giving each WordPress site its own isolated folder.
    syncFolderPath: idx >= 0 ? targets[idx].syncFolderPath : '',
    pullDrafts: current.pullDrafts,
    pullPublished: current.pullPublished,
    conflictStrategy: current.conflictStrategy,
    syncMode: current.syncMode,
    // Editing keeps the prior selection unless the caller passes a new one;
    // a brand-new target with no explicit selection opts into nothing ([]).
    contentKinds: resolveContentKinds('wordpress', contentKinds, idx >= 0 ? targets[idx] : undefined),
    adapter: {
      platform: 'wordpress',
      siteUrl: normalizedUrl,
      username,
      appPassword,
    },
  };

  if (idx >= 0) {
    targets[idx] = target;
  } else {
    targets.push(target);
  }
  writeConfig({ ...current, targets });
}

/**
 * Add or update a Ghost blog target from the connect form. Mirrors
 * `upsertWordPressTarget`: a NEW blog gets a unique slugified handle (from the
 * Ghost URL host, falling back to the label), de-duped against every existing
 * handle, with an EMPTY syncFolderPath so each blog lands in its own
 * `handle/` folder. An existing blog (matched by normalized host) is updated
 * in place, preserving its handle and folder.
 *
 * Unlike the legacy single-Ghost Settings window — which folds creds into
 * targets[0] — this never touches any other target, so a second/third Ghost
 * blog coexists with the first.
 */
export function upsertGhostTarget(
  ghostUrl: string,
  adminApiKey: string,
  label?: string,
  contentKinds?: ContentKind[],
): void {
  const current = readConfig();
  if (!current?.vaultPath) {
    throw new Error('Set up a local sync folder before adding a Ghost blog.');
  }

  const normalizedUrl = normalizeGhostUrl(ghostUrl);
  const host = hostnameOf(normalizedUrl) || 'ghost';

  const targets = current.targets ? [...current.targets] : [];
  const idx = targets.findIndex(
    (existing) =>
      existing.adapter.platform === 'ghost' &&
      hostnameOf(existing.adapter.ghostUrl ?? '') === host,
  );

  const handle =
    idx >= 0
      ? targets[idx].handle
      : uniqueHandle(slugifyHandle(host || label || 'ghost'), targets.map((t) => t.handle));

  const target: TargetConfig = {
    handle,
    label: label?.trim() || (idx >= 0 ? targets[idx].label : 'Ghost'),
    syncFolderPath: idx >= 0 ? targets[idx].syncFolderPath : '',
    pullDrafts: current.pullDrafts,
    pullPublished: current.pullPublished,
    conflictStrategy: current.conflictStrategy,
    syncMode: current.syncMode,
    contentKinds: resolveContentKinds('ghost', contentKinds, idx >= 0 ? targets[idx] : undefined),
    adapter: {
      platform: 'ghost',
      ghostUrl: normalizedUrl,
      adminApiKey,
    },
  };

  if (idx >= 0) {
    targets[idx] = target;
  } else {
    targets.push(target);
  }
  writeConfig({ ...current, targets });
}

/**
 * Remove a target by handle. Splices it out of `targets[]` and writes the
 * config atomically (via writeConfig, which preserves the remaining targets
 * verbatim). Returns false when the handle is unknown so callers can surface a
 * meaningful error. The supervisor restart is the caller's responsibility
 * (see the `config:remove-target` IPC handler).
 */
export function removeTarget(
  handle: string,
): { ok: true } | { ok: false; error: string } {
  const current = readConfig();
  if (!current) return { ok: false, error: 'No config on disk yet.' };
  const targets = current.targets ?? [];
  const idx = targets.findIndex((t) => t.handle === handle);
  if (idx < 0) return { ok: false, error: `Unknown target: ${handle}` };

  const nextTargets = targets.filter((_, i) => i !== idx);
  try {
    // Write the trimmed list verbatim. We bypass writeConfig's legacy-edit
    // branch by always passing an explicit `targets` array — when the last
    // target is removed we pass an empty array so the daemon sees "no targets"
    // rather than a re-synthesized Ghost.
    writeConfigAtomic({
      ...current,
      targets: nextTargets,
      ...(nextTargets[0]?.adapter.platform === 'ghost'
        ? {
            ghostUrl: nextTargets[0].adapter.ghostUrl ?? '',
            adminApiKey: nextTargets[0].adapter.adminApiKey ?? '',
            syncFolderPath: nextTargets[0].syncFolderPath ?? '',
          }
        : { ghostUrl: '', adminApiKey: '', syncFolderPath: '' }),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Resolve the `contentKinds` to persist for a Ghost/WordPress upsert.
 *
 * - An explicit selection (from the connect form) wins, filtered to the
 *   platform's supported kinds. The connect renderer always passes one — even
 *   an empty array, which is a valid "sync nothing" choice.
 * - No explicit selection while EDITING an existing target → keep its prior
 *   (normalized) selection so a label-only save doesn't wipe it.
 * - No explicit selection on a BRAND-NEW target → empty array (opt-in: nothing
 *   syncs until the user ticks a kind).
 */
function resolveContentKinds(
  platform: Platform,
  explicit: ContentKind[] | undefined,
  existing: TargetConfig | undefined,
): ContentKind[] {
  const supported = PLATFORM_KINDS[platform];
  if (Array.isArray(explicit)) {
    return explicit.filter((k) => supported.includes(k));
  }
  if (existing) return normalizeContentKinds(existing);
  return [];
}

function normalizeGhostUrl(raw: string): string {
  let s = raw.trim();
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  while (s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

function normalizeWordPressSiteUrl(raw: string): string {
  let s = raw.trim();
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  while (s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

function hostnameOf(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

export interface ShopifyTokenFields {
  accessToken: string;
  refreshToken?: string;
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
}

export function upsertShopifyTarget(
  shop: string,
  token: string | ShopifyTokenFields,
  contentKinds?: ContentKind[],
): void {
  const current = readConfig();
  if (!current?.vaultPath) {
    throw new Error('Set up a local sync folder before connecting Shopify.');
  }
  const tokenFields: ShopifyTokenFields =
    typeof token === 'string' ? { accessToken: token } : token;

  const targets = current.targets ? [...current.targets] : [];
  const idx = targets.findIndex(
    (existing) => existing.adapter.platform === 'shopify' && existing.adapter.shop === shop,
  );

  // New store → unique slugified handle so a 2nd Shopify store can't collide
  // with the first (the old code hardcoded syncFolderPath:'shopify', which
  // would have made two stores share a folder). Existing store keeps its handle.
  const storeSlug = slugifyHandle(shop.replace(/\.myshopify\.com$/i, '')) || 'store';
  const handle =
    idx >= 0
      ? targets[idx].handle
      : uniqueHandle(`shopify-${storeSlug}`, targets.map((t) => t.handle));

  const target: TargetConfig = {
    handle,
    label: idx >= 0 ? targets[idx].label : 'Shopify',
    // Empty by default → each store syncs into its own `handle/` folder.
    syncFolderPath: idx >= 0 ? targets[idx].syncFolderPath : '',
    pullDrafts: current.pullDrafts,
    pullPublished: current.pullPublished,
    conflictStrategy: current.conflictStrategy,
    syncMode: current.syncMode,
    // Shopify has no connect form — a freshly OAuth'd store defaults to the
    // base post kind ['article'] (the user changes it later via Edit). An
    // explicit list (Edit path) overrides; an existing store keeps its prior
    // selection when none is passed.
    contentKinds:
      contentKinds ??
      (idx >= 0
        ? normalizeContentKinds(targets[idx])
        : [baseKind('shopify')]),
    adapter: {
      platform: 'shopify',
      shop,
      accessToken: tokenFields.accessToken,
      refreshToken: tokenFields.refreshToken,
      accessTokenExpiresAt: tokenFields.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokenFields.refreshTokenExpiresAt,
    },
  };

  if (idx >= 0) {
    targets[idx] = target;
  } else {
    targets.push(target);
  }
  writeConfig({ ...current, targets });
}
