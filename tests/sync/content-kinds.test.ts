/**
 * Content-kind opt-in tests.
 *
 * The product rule: nothing syncs unless the target explicitly enables that
 * kind. Pull lists only enabled kinds (empty = nothing); push skips local
 * files whose kind isn't enabled. Legacy configs (no `contentKinds` field)
 * migrate to the platform's base post kind so existing post sync is preserved.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShopifyAdapter } from '../../src/shopify/adapter.js';
import { SyncEngine } from '../../src/sync/engine.js';
import { Vault } from '../../src/vault.js';
import { DEFAULT_SETTINGS, GhostSyncSettings } from '../../src/types.js';
import { basePostKind, loadConfig, PLATFORM_KINDS } from '../../src/config.js';
import { serializePostContent } from '../../src/utils/frontmatter.js';
import { FakeShopifyApi } from '../fakes/FakeShopifyApi.js';
import { makeTmpVault, writeFile } from '../fakes/tmpVault.js';

function settings(overrides: Partial<GhostSyncSettings> = {}): GhostSyncSettings {
  return { ...DEFAULT_SETTINGS, syncFolderPath: '', contentKinds: ['article', 'page', 'product'], ...overrides };
}

function pageFile() {
  return serializePostContent(
    {
      cms_kind: 'page',
      ghost_id: null,
      ghost_slug: null,
      ghost_status: 'draft',
      ghost_updated_at: null,
      local_updated_at: null,
      tags: [],
      feature_image: null,
      excerpt: null,
    },
    'A Page',
    'Body.',
    { platform: 'shopify', kind: 'page' },
  );
}

describe('content-kind helpers', () => {
  it('base post kind is the platform default', () => {
    expect(basePostKind('ghost')).toBe('post');
    expect(basePostKind('wordpress')).toBe('post');
    expect(basePostKind('shopify')).toBe('article');
  });
  it('Shopify is the only platform offering products', () => {
    expect(PLATFORM_KINDS.shopify).toContain('product');
    expect(PLATFORM_KINDS.ghost).not.toContain('product');
  });
});

describe('pull gating', () => {
  let vault: Vault;
  let root: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ vault, root, cleanup } = await makeTmpVault());
  });
  afterEach(async () => {
    await cleanup();
  });

  it('pulls nothing — and never calls the API — when no kinds are enabled', async () => {
    const api = new FakeShopifyApi();
    api.seedDefaultBlog();
    // seed a page so we'd notice if it leaked through
    let listCalls = 0;
    const adapter = new ShopifyAdapter(api, 'fake.myshopify.com');
    const orig = adapter.listContent.bind(adapter);
    adapter.listContent = (o) => {
      listCalls += 1;
      return orig(o);
    };
    const engine = new SyncEngine(vault, adapter, settings({ contentKinds: [] }));

    const result = await engine.pull();

    expect(result.created).toEqual([]);
    expect(listCalls).toBe(0);
  });
});

describe('push gating', () => {
  let vault: Vault;
  let root: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ vault, root, cleanup } = await makeTmpVault());
  });
  afterEach(async () => {
    await cleanup();
  });

  it('skips a local page when only articles are enabled', async () => {
    await writeFile(root, 'a-page.md', pageFile());
    const api = new FakeShopifyApi();
    api.seedDefaultBlog();
    const adapter = new ShopifyAdapter(api, 'fake.myshopify.com');
    const engine = new SyncEngine(vault, adapter, settings({ contentKinds: ['article'] }));

    const result = await engine.push();

    expect(result.created).toEqual([]);
    expect(result.skipped).toContain('A Page');
    expect(api.pages.size).toBe(0);
  });

  it('pushes the page once it is enabled', async () => {
    await writeFile(root, 'a-page.md', pageFile());
    const api = new FakeShopifyApi();
    api.seedDefaultBlog();
    const adapter = new ShopifyAdapter(api, 'fake.myshopify.com');
    const engine = new SyncEngine(vault, adapter, settings({ contentKinds: ['article', 'page'] }));

    const result = await engine.push();

    expect(result.created).toEqual(['A Page']);
    expect(api.pages.size).toBe(1);
  });
});

describe('legacy config migration', () => {
  let tmpHome: string;
  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-kinds-'));
    process.env.XDG_CONFIG_HOME = path.join(tmpHome, 'config');
    process.env.XDG_STATE_HOME = path.join(tmpHome, 'state');
  });
  afterEach(async () => {
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_STATE_HOME;
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  async function writeRawConfig(obj: unknown): Promise<void> {
    const dir = path.join(process.env.XDG_CONFIG_HOME!, 'ghost-sync');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(obj), 'utf8');
  }

  const target = (platform: string, extra: Record<string, unknown> = {}) => ({
    handle: 'h',
    label: 'L',
    syncFolderPath: '',
    pullDrafts: true,
    pullPublished: true,
    conflictStrategy: 'ask',
    syncMode: 'auto',
    adapter:
      platform === 'shopify'
        ? { platform: 'shopify', shop: 's.myshopify.com', accessToken: 't' }
        : { platform: 'ghost', ghostUrl: 'https://g.ghost.io', adminApiKey: 'i:s' },
    ...extra,
  });

  it('backfills a Ghost target with no contentKinds to posts-only', async () => {
    await writeRawConfig({ vaultPath: '/v', watchDebounceMs: 2000, targets: [target('ghost')] });
    const cfg = await loadConfig();
    expect(cfg!.targets[0].contentKinds).toEqual(['post']);
  });

  it('backfills a Shopify target with no contentKinds to articles-only', async () => {
    await writeRawConfig({ vaultPath: '/v', watchDebounceMs: 2000, targets: [target('shopify')] });
    const cfg = await loadConfig();
    expect(cfg!.targets[0].contentKinds).toEqual(['article']);
  });

  it('preserves an explicit empty list (sync nothing)', async () => {
    await writeRawConfig({
      vaultPath: '/v',
      watchDebounceMs: 2000,
      targets: [target('ghost', { contentKinds: [] })],
    });
    const cfg = await loadConfig();
    expect(cfg!.targets[0].contentKinds).toEqual([]);
  });

  it('filters out kinds the platform does not support', async () => {
    await writeRawConfig({
      vaultPath: '/v',
      watchDebounceMs: 2000,
      targets: [target('ghost', { contentKinds: ['post', 'product', 'page'] })],
    });
    const cfg = await loadConfig();
    expect(cfg!.targets[0].contentKinds).toEqual(['post', 'page']);
  });
});
