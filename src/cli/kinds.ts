/**
 * List the content kinds available for a platform.
 *
 * Static-kind platforms (Ghost, WordPress, Shopify) return their fixed
 * `PLATFORM_KINDS` table. Dynamic-kind platforms (Webflow — one kind per CMS
 * collection) are queried live via the adapter's `listContentKinds()`.
 *
 * Used by the desktop "Add Webflow" form to render real collection checkboxes
 * after a successful connection test. Ad-hoc credentials bypass any saved
 * config, mirroring `test --platform webflow`.
 *
 *   ghost-sync kinds --platform webflow --site-id <id> --api-token <tok> --json
 *     -> { ok: true, kinds: ["webflow:blog-posts", "webflow:guides"] }
 */

import { createAdapter } from '../cms/index.js';
import { AdapterConfig } from '../cms/types.js';
import { PLATFORM_KINDS } from '../config.js';

interface KindsOptions {
  platform?: 'ghost' | 'shopify' | 'wordpress' | 'webflow';
  // Webflow ad-hoc flags
  siteId?: string;
  apiToken?: string;
  json?: boolean;
}

export async function kindsCommand(options: KindsOptions): Promise<void> {
  const json = options.json ?? false;

  let adapterConfig: AdapterConfig | null = null;
  if (options.platform === 'webflow' && options.siteId && options.apiToken) {
    adapterConfig = {
      platform: 'webflow',
      siteId: options.siteId,
      apiToken: options.apiToken,
    };
  }

  if (!adapterConfig) {
    // No live credentials → fall back to the static table for the platform.
    const platform = options.platform ?? 'ghost';
    emit(json, true, PLATFORM_KINDS[platform] ?? []);
    return;
  }

  try {
    const adapter = createAdapter(adapterConfig);
    const kinds = adapter.listContentKinds
      ? await adapter.listContentKinds()
      : PLATFORM_KINDS[adapterConfig.platform];
    emit(json, true, kinds);
  } catch (err) {
    emitError(json, err instanceof Error ? err.message : String(err));
  }
}

function emit(json: boolean, ok: boolean, kinds: string[]): void {
  if (json) {
    process.stdout.write(JSON.stringify({ ok, kinds }) + '\n');
  } else {
    for (const k of kinds) console.log(k);
  }
  process.exit(ok ? 0 : 1);
}

function emitError(json: boolean, message: string): void {
  if (json) {
    process.stdout.write(JSON.stringify({ ok: false, error: message }) + '\n');
  } else {
    console.error(message);
  }
  process.exit(1);
}
