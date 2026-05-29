import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ShopifyAdapter } from '../../src/shopify/adapter.js';
import { SyncEngine } from '../../src/sync/engine.js';
import { Vault } from '../../src/vault.js';
import { DEFAULT_SETTINGS, GhostSyncSettings } from '../../src/types.js';
import { parsePostContent, serializePostContent } from '../../src/utils/frontmatter.js';
import { FakeShopifyApi } from '../fakes/FakeShopifyApi.js';
import { makeTmpVault, readFile, writeFile } from '../fakes/tmpVault.js';

function settings(overrides: Partial<GhostSyncSettings> = {}): GhostSyncSettings {
  return { ...DEFAULT_SETTINGS, syncFolderPath: '', ...overrides };
}

describe('SyncEngine with Shopify content kinds', () => {
  let vault: Vault;
  let root: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ vault, root, cleanup } = await makeTmpVault());
  });

  afterEach(async () => {
    await cleanup();
  });

  it('pushes a local page draft to Shopify pages', async () => {
    const local = serializePostContent(
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
      'Shopify About',
      'About page body.',
      { platform: 'shopify', kind: 'page' },
    );
    await writeFile(root, 'shopify-about.md', local);

    const api = new FakeShopifyApi();
    api.seedDefaultBlog();
    const adapter = new ShopifyAdapter(api, 'fake.myshopify.com');
    const engine = new SyncEngine(vault, adapter, settings());

    const result = await engine.push();

    expect(result.created).toEqual(['Shopify About']);
    expect(api.pages.size).toBe(1);
    expect(api.articles.size).toBe(0);
    const page = Array.from(api.pages.values())[0];
    expect(page.title).toBe('Shopify About');
    expect(page.body).toContain('About page body.');

    const updated = parsePostContent(await readFile(root, 'shopify-about.md'));
    expect(updated.frontmatter.cms_kind).toBe('page');
    expect(updated.frontmatter.ghost_id).toBe(page.id);
  });

  it('pushes a local product draft to Shopify products', async () => {
    const local = serializePostContent(
      {
        cms_kind: 'product',
        ghost_id: null,
        ghost_slug: null,
        ghost_status: 'draft',
        ghost_updated_at: null,
        local_updated_at: null,
        tags: ['merch'],
        feature_image: null,
        excerpt: null,
      },
      'Shopify Mug',
      'A **nice** mug.',
      { platform: 'shopify', kind: 'product' },
    );
    await writeFile(root, 'shopify-mug.md', local);

    const api = new FakeShopifyApi();
    api.seedDefaultBlog();
    const adapter = new ShopifyAdapter(api, 'fake.myshopify.com');
    const engine = new SyncEngine(vault, adapter, settings());

    const result = await engine.push();

    expect(result.created).toEqual(['Shopify Mug']);
    expect(api.products.size).toBe(1);
    expect(api.articles.size).toBe(0);
    expect(api.pages.size).toBe(0);
    const product = Array.from(api.products.values())[0];
    expect(product.title).toBe('Shopify Mug');
    expect(product.descriptionHtml).toContain('<strong>nice</strong>');
    expect(product.tags).toEqual(['merch']);

    const updated = parsePostContent(await readFile(root, 'shopify-mug.md'));
    expect(updated.frontmatter.cms_kind).toBe('product');
    expect(updated.frontmatter.ghost_id).toBe(product.id);
  });
});
