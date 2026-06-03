/**
 * Pure config-shape types and the target-merge contract.
 * Lives separately from config.ts so it can be unit-tested without dragging
 * in Electron through the paths.ts import chain.
 */

export type Platform = 'ghost' | 'shopify' | 'wordpress' | 'webflow';

/** Content kinds the daemon understands. Mirrors `ContentKind` in
 *  src/cms/types.ts. Webflow kinds are dynamic (`webflow:<collectionSlug>`, one
 *  per CMS collection); the closed sets below cover the fixed-kind platforms. */
export type ContentKind = 'post' | 'page' | 'article' | 'product' | `webflow:${string}`;

/** Content kinds each platform can sync, in the order the UI should offer them.
 *  First entry is the base post kind (the conservative legacy-migration
 *  default). Mirrors `PLATFORM_KINDS` in src/config.ts exactly. Webflow's real
 *  kinds are its live collections, enumerated at connect time; `['post']` is
 *  just the legacy-migration base. */
export const PLATFORM_KINDS: Record<Platform, ContentKind[]> = {
  ghost: ['post', 'page'],
  wordpress: ['post', 'page'],
  shopify: ['article', 'page', 'product'],
  webflow: ['post'],
};

/** Whether a content kind is valid for a platform. Webflow accepts any kind
 *  with its `webflow:` prefix (its real set is the live site's collections);
 *  fixed-kind platforms match the static table. Mirrors `isContentKindAllowed`
 *  in src/config.ts — without it dynamic kinds get filtered out and the target
 *  silently syncs nothing. */
export function isContentKindAllowed(platform: Platform, kind: ContentKind): boolean {
  if (platformKinds(platform).includes(kind)) return true;
  if (platform === 'webflow') return String(kind).startsWith('webflow:');
  return false;
}

/** The kinds a platform can offer. Defensive fallback to `['post']` for an
 *  unknown platform string. */
export function platformKinds(platform: Platform): ContentKind[] {
  return PLATFORM_KINDS[platform] ?? ['post'];
}

/** The base post kind for a platform — what a legacy target (no explicit
 *  `contentKinds`) normalizes to so existing post sync keeps working. Mirrors
 *  `basePostKind` in src/config.ts. */
export function baseKind(platform: Platform): ContentKind {
  return platformKinds(platform)[0];
}

/** Normalize a target's `contentKinds` for display + persistence:
 *  - present (incl. empty `[]`, meaning "sync nothing") → kept as-is, filtered
 *    to kinds the platform actually supports;
 *  - absent (legacy config) → migrated to the platform's base post kind so a
 *    pre-existing target keeps syncing posts and never silently goes dark.
 *  Matches the daemon's `normalizeContentKinds` in src/config.ts. */
export function normalizeContentKinds(target: TargetConfig): ContentKind[] {
  const platform = target.adapter.platform;
  if (Array.isArray(target.contentKinds)) {
    return target.contentKinds.filter((k) => isContentKindAllowed(platform, k));
  }
  return [baseKind(platform)];
}

export interface AdapterConfig {
  platform: Platform;
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
  // Webflow-specific
  siteId?: string;
  apiToken?: string;
  fieldMap?: Record<string, { title?: string; slug?: string; body?: string; tags?: string }>;
}

export interface TargetConfig {
  handle: string;
  label: string;
  syncFolderPath: string;
  pullDrafts: boolean;
  pullPublished: boolean;
  conflictStrategy: 'ask' | 'keep_local' | 'keep_remote';
  syncMode: 'auto' | 'manual';
  /** Per-target opt-in: which content kinds sync (both directions). Empty array
   *  means "sync nothing". Absent in a legacy config → normalized to the
   *  platform's base post kind. */
  contentKinds?: ContentKind[];
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
  /** Origin of the OAuth broker for hosted OAuth flows (Shopify, Webflow).
   *  Optional: absent → hosted default (`https://spectersync.com`). PRO leaves
   *  it unset; DIY users self-hosting a broker set it to their origin. Read by
   *  the shell only — the daemon ignores it. See `oauthBaseUrl()` in oauth.ts. */
  oauthBaseUrl?: string;
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
    // Non-destructive: keep the full list verbatim, but normalize each target's
    // contentKinds so a legacy (field-less) target round-trips with its base
    // kind made explicit — mirroring the daemon's backfill.
    return existing.map((t) => ({ ...t, contentKinds: normalizeContentKinds(t) }));
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
    // Legacy single-Ghost first run → base post kind, matching the daemon.
    contentKinds: [baseKind('ghost')],
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
