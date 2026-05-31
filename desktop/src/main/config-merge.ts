/**
 * Pure config-shape types and the target-merge contract.
 * Lives separately from config.ts so it can be unit-tested without dragging
 * in Electron through the paths.ts import chain.
 */

export interface AdapterConfig {
  platform: 'ghost' | 'shopify' | 'wordpress';
  // Ghost-specific
  ghostUrl?: string;
  adminApiKey?: string;
  // Shopify-specific
  shop?: string;
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
  apiVersion?: string;
  // WordPress-specific
  siteUrl?: string;
  username?: string;
  appPassword?: string;
}

export interface TargetConfig {
  handle: string;
  label: string;
  syncFolderPath: string;
  pullDrafts: boolean;
  pullPublished: boolean;
  conflictStrategy: 'ask' | 'keep_local' | 'keep_remote';
  syncMode: 'auto' | 'manual';
  adapter: AdapterConfig;
}

export interface AppConfig {
  ghostUrl: string;
  adminApiKey: string;
  vaultPath: string;
  syncFolderPath: string;
  pullDrafts: boolean;
  pullPublished: boolean;
  conflictStrategy: 'ask' | 'keep_local' | 'keep_remote';
  syncMode: 'auto' | 'manual';
  watchDebounceMs: number;
  targets?: TargetConfig[];
}

/**
 * Reconcile `targets[]` for persistence WITHOUT collapsing the multi-target
 * list into a single `handle:'ghost'` slot.
 *
 * - Empty-targets first-run: synthesize ONE Ghost target from the legacy flat
 *   fields (the only path that ever invents a `handle:'ghost'`).
 * - Otherwise: preserve every target as-is. Multi-target configs round-trip
 *   untouched — `targets[1..N]` are never dropped or merged away. The legacy
 *   flat fields are treated as a mirror of `targets[0]` (see `legacyFromTargets`)
 *   rather than a source the engine must re-synthesize from.
 */
export function mergeTargetsForConfig(
  existing: TargetConfig[] | undefined,
  legacy: AppConfig,
): TargetConfig[] {
  if (existing && existing.length > 0) {
    // Non-destructive: keep the full list verbatim.
    return existing;
  }
  // First-run only: derive a single Ghost target from the legacy flat fields.
  const synthesized: TargetConfig = {
    handle: 'ghost',
    label: 'Ghost',
    syncFolderPath: legacy.syncFolderPath,
    pullDrafts: legacy.pullDrafts,
    pullPublished: legacy.pullPublished,
    conflictStrategy: legacy.conflictStrategy,
    syncMode: legacy.syncMode,
    adapter: {
      platform: 'ghost',
      ghostUrl: legacy.ghostUrl,
      adminApiKey: legacy.adminApiKey,
    },
  };
  return [synthesized];
}

/**
 * Slugify an arbitrary host/shop/label into a daemon-legal target handle.
 *
 * Matches the daemon's `saveConfig` validation exactly:
 *   handle regex ^[a-z0-9][a-z0-9-]*$
 * Lowercase, strip URL scheme, collapse runs of non-[a-z0-9] into a single
 * '-', trim leading/trailing '-'. Falls back to "target" when nothing legal
 * survives (e.g. an all-symbol label).
 */
export function slugifyHandle(raw: string): string {
  let s = (raw ?? '').trim().toLowerCase();
  // Strip a URL scheme if present (https://, http://, etc).
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  // Collapse every run of non-[a-z0-9] into a single hyphen.
  s = s.replace(/[^a-z0-9]+/g, '-');
  // Trim leading/trailing hyphens (the regex forbids a leading '-').
  s = s.replace(/^-+|-+$/g, '');
  return s.length > 0 ? s : 'target';
}

/**
 * Make `base` unique among `taken` by appending -2, -3, … until free.
 * Used so a second Ghost blog / second Shopify store never collides with an
 * existing target's handle (and, since the multi-target folder is derived from
 * the handle, never shares a sync folder either).
 */
export function uniqueHandle(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}
