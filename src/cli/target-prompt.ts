/**
 * Interactive prompt helpers shared by `init` (first target) and
 * `target add`/`target edit` (additional targets). Keeping the adapter and
 * per-target-settings prompts in one place means every CMS is offered the same
 * way no matter which command the user runs, and there's a single source of
 * truth for the questions.
 */

import { createAdapter } from '../cms/index.js';
import { AdapterConfig, ContentKind } from '../cms/types.js';
import { PLATFORM_KINDS, TargetConfig } from '../config.js';

export type Ask = (question: string, fallback: string) => Promise<string>;

export const PLATFORMS = ['ghost', 'wordpress', 'shopify', 'webflow'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Ask which platform to configure, validating the answer. */
export async function promptPlatform(ask: Ask, fallback: Platform = 'ghost'): Promise<Platform> {
  const input = (await ask('Platform (ghost | wordpress | shopify | webflow)', fallback)).toLowerCase();
  if (!(PLATFORMS as readonly string[]).includes(input)) {
    throw new Error(
      `Unknown platform '${input}'. Supported platforms: ${PLATFORMS.join(', ')}`,
    );
  }
  return input as Platform;
}

/** Prompt for the credentials of one platform, returning a typed AdapterConfig.
 *  `existing` (when editing) supplies the default values. */
export async function promptAdapter(
  ask: Ask,
  platform: Platform,
  existing?: AdapterConfig,
): Promise<AdapterConfig> {
  if (platform === 'ghost') {
    const ghostUrl = await ask(
      'Ghost URL (e.g. https://yourblog.ghost.io)',
      existing?.platform === 'ghost' ? existing.ghostUrl : '',
    );
    const adminApiKey = await ask(
      'Admin API Key (id:secret)',
      existing?.platform === 'ghost' ? existing.adminApiKey : '',
    );
    return { platform: 'ghost', ghostUrl, adminApiKey };
  }
  if (platform === 'wordpress') {
    const siteUrl = await ask(
      'WordPress site URL (e.g. https://yourblog.com)',
      existing?.platform === 'wordpress' ? existing.siteUrl : '',
    );
    const username = await ask(
      'WordPress username',
      existing?.platform === 'wordpress' ? existing.username : '',
    );
    const appPasswordRaw = await ask(
      'WordPress Application Password (24 chars)',
      existing?.platform === 'wordpress' ? existing.appPassword : '',
    );
    return {
      platform: 'wordpress',
      siteUrl,
      username,
      appPassword: appPasswordRaw.replace(/\s+/g, ''),
    };
  }
  if (platform === 'webflow') {
    const siteId = await ask(
      'Webflow site ID',
      existing?.platform === 'webflow' ? existing.siteId : '',
    );
    // CLI configures the AGPL site-token path. The PRO OAuth flow is hosted
    // (web/) and writes accessToken/refreshToken into the config directly.
    const apiToken = await ask(
      'Webflow site API token',
      existing?.platform === 'webflow' ? (existing.apiToken ?? '') : '',
    );
    return { platform: 'webflow', siteId, apiToken };
  }
  // shopify
  const shop = await ask(
    'Shopify shop domain (e.g. your-store.myshopify.com)',
    existing?.platform === 'shopify' ? existing.shop : '',
  );
  const accessToken = await ask(
    'Shopify Admin Access Token (shpat_...)',
    existing?.platform === 'shopify' ? existing.accessToken : '',
  );
  const apiVersion = await ask(
    'Shopify API Version (e.g. 2024-04)',
    (existing?.platform === 'shopify' && existing.apiVersion) || '2024-04',
  );
  return { platform: 'shopify', shop, accessToken, apiVersion };
}

/**
 * Resolve the content kinds a target can offer. Platforms with a fixed kind
 * set use the static `PLATFORM_KINDS` table; platforms with dynamic kinds
 * (Webflow — one kind per CMS collection) are queried live via the adapter's
 * optional `listContentKinds()`. On a connection failure we warn and return an
 * empty list so the connect flow can still proceed (the user re-runs once the
 * token is valid) rather than offering a wrong static default.
 */
export async function availableContentKinds(adapter: AdapterConfig): Promise<ContentKind[]> {
  const cms = createAdapter(adapter);
  if (!cms.listContentKinds) return PLATFORM_KINDS[adapter.platform];
  try {
    return await cms.listContentKinds();
  } catch (err) {
    console.log(
      `  ⚠️  Could not list ${adapter.platform} collections: ${(err as Error).message}`,
    );
    return [];
  }
}

/**
 * Prompt for which content kinds this target should sync. Opt-in: the user
 * picks from the available kinds; nothing is enabled implicitly. `current`
 * seeds the default answer (current selection when editing, empty when adding).
 * `available` overrides the static `PLATFORM_KINDS[platform]` set — pass the
 * result of {@link availableContentKinds} for platforms with dynamic kinds.
 * Returns the validated, available subset.
 */
export async function promptContentKinds(
  ask: Ask,
  platform: Platform,
  current: ContentKind[] = [],
  available: ContentKind[] = PLATFORM_KINDS[platform],
): Promise<ContentKind[]> {
  const fallback = current.length > 0 ? current.join(',') : '';
  const answer = await ask(
    `Content to sync — comma-separated from [${available.join(', ')}] (blank = nothing)`,
    fallback,
  );
  const picked = answer
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .filter((k): k is ContentKind => (available as string[]).includes(k));
  if (picked.length === 0) {
    console.log('  ⚠️  No content kinds selected — this target will sync nothing until you enable one.');
  }
  // De-dupe while preserving the platform's canonical order.
  return available.filter((k) => picked.includes(k));
}

/** The per-target sync preferences (everything on a target except handle/adapter). */
export type TargetSettings = Pick<
  TargetConfig,
  'label' | 'syncFolderPath' | 'pullDrafts' | 'pullPublished' | 'conflictStrategy' | 'syncMode'
>;

const asBool = (s: string, fallback: boolean): boolean => {
  const v = s.trim().toLowerCase();
  if (v === '') return fallback;
  return v === 'y' || v === 'yes' || v === 'true';
};

/**
 * Prompt for the per-target settings. `defaults` seeds the answers (current
 * values when editing, sensible defaults when adding). `multi` controls the
 * sync-folder prompt copy: with more than one target the folder is relative to
 * the target's handle subfolder.
 */
export async function promptTargetSettings(
  ask: Ask,
  defaults: TargetSettings,
  multi: boolean,
): Promise<TargetSettings> {
  const label = await ask('Label (display name)', defaults.label);
  const folderHint = multi
    ? 'Sub-folder within this target (blank = the target handle folder)'
    : 'Sync folder (relative to vault root)';
  const syncFolderPath = await ask(folderHint, defaults.syncFolderPath);
  const pullDrafts = asBool(
    await ask('Pull drafts? (y/n)', defaults.pullDrafts ? 'y' : 'n'),
    defaults.pullDrafts,
  );
  const pullPublished = asBool(
    await ask('Pull published? (y/n)', defaults.pullPublished ? 'y' : 'n'),
    defaults.pullPublished,
  );
  const conflictStrategy = (await ask(
    'Conflict strategy (ask | keep_local | keep_remote)',
    defaults.conflictStrategy,
  )) as TargetSettings['conflictStrategy'];
  const syncMode = (await ask(
    'Sync mode (auto | manual)',
    defaults.syncMode,
  )) as TargetSettings['syncMode'];
  return { label, syncFolderPath, pullDrafts, pullPublished, conflictStrategy, syncMode };
}
