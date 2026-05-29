/**
 * Reads and writes the daemon's config.json.
 * Shape mirrors src/config.ts DaemonConfig + GhostSyncSettings + TargetConfig.
 *
 * v0.4.0: gained `targets[]`. The Electron UI is still single-target — it
 * edits the legacy flat fields, and `writeConfig` regenerates targets[0]
 * from those fields on save. Hand-edited multi-target configs round-trip
 * cleanly (targets[1..N] preserved).
 */

import fs from 'fs';
import path from 'path';
import { configFilePath, configDir } from './paths.js';
import {
  mergeTargetsForConfig,
  type AdapterConfig,
  type AppConfig,
  type TargetConfig,
} from './config-merge.js';

export { mergeTargetsForConfig };
export type { AdapterConfig, AppConfig, TargetConfig };

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
  const toWrite: AppConfig = { ...cfg, targets: mergeTargetsForConfig(cfg.targets, cfg) };
  writeConfigAtomic(toWrite);
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
 * Add or update a WordPress target from the connect form. The site URL is
 * normalized (default https://, trailing slashes stripped) before persistence
 * so duplicate-detection (and the per-target folder name) work off a stable
 * hostname.
 */
export function upsertWordPressTarget(
  siteUrl: string,
  username: string,
  appPassword: string,
): void {
  const current = readConfig();
  if (!current?.vaultPath) {
    throw new Error('Set up a local sync folder before adding a new site.');
  }

  const normalizedUrl = normalizeWordPressSiteUrl(siteUrl);
  const host = hostnameOf(normalizedUrl) || 'site';
  const slug = host.replace(/\./g, '-').replace(/_/g, '-').toLowerCase();
  const handle = `wordpress-${slug}`;

  const target: TargetConfig = {
    handle,
    label: 'WordPress',
    syncFolderPath: handle,
    pullDrafts: current.pullDrafts,
    pullPublished: current.pullPublished,
    conflictStrategy: current.conflictStrategy,
    syncMode: current.syncMode,
    adapter: {
      platform: 'wordpress',
      siteUrl: normalizedUrl,
      username,
      appPassword,
    },
  };

  const targets = current.targets ? [...current.targets] : [];
  const idx = targets.findIndex(
    (existing) =>
      existing.adapter.platform === 'wordpress' &&
      hostnameOf(existing.adapter.siteUrl ?? '') === host,
  );
  if (idx >= 0) {
    targets[idx] = target;
  } else {
    targets.push(target);
  }
  writeConfig({ ...current, targets });
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

export function upsertShopifyTarget(shop: string, token: string | ShopifyTokenFields): void {
  const current = readConfig();
  if (!current?.vaultPath) {
    throw new Error('Set up a local sync folder before connecting Shopify.');
  }
  const tokenFields: ShopifyTokenFields =
    typeof token === 'string' ? { accessToken: token } : token;

  const handle = shop
    .replace(/\.myshopify\.com$/i, '')
    .replace(/[^a-z0-9-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();

  const target: TargetConfig = {
    handle: `shopify-${handle || 'store'}`,
    label: 'Shopify',
    syncFolderPath: 'shopify',
    pullDrafts: current.pullDrafts,
    pullPublished: current.pullPublished,
    conflictStrategy: current.conflictStrategy,
    syncMode: current.syncMode,
    adapter: {
      platform: 'shopify',
      shop,
      accessToken: tokenFields.accessToken,
      refreshToken: tokenFields.refreshToken,
      accessTokenExpiresAt: tokenFields.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokenFields.refreshTokenExpiresAt,
    },
  };

  const targets = current.targets ? [...current.targets] : [];
  const idx = targets.findIndex(
    (existing) => existing.adapter.platform === 'shopify' && existing.adapter.shop === shop,
  );
  if (idx >= 0) {
    targets[idx] = target;
  } else {
    targets.push(target);
  }
  writeConfig({ ...current, targets });
}
