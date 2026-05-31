import { describe, expect, it } from 'vitest';
import {
  mergeTargetsForConfig,
  normalizeContentKinds,
  baseKind,
  platformKinds,
  slugifyHandle,
  uniqueHandle,
  type AppConfig,
  type TargetConfig,
} from '../../desktop/src/main/config-merge';

const base: AppConfig = {
  ghostUrl: 'http://localhost:2368',
  adminApiKey: 'id:secret',
  vaultPath: '/tmp/specter',
  syncFolderPath: '',
  pullDrafts: true,
  pullPublished: true,
  conflictStrategy: 'ask',
  syncMode: 'manual',
  watchDebounceMs: 2000,
};

const shopify: TargetConfig = {
  handle: 'shopify-specter',
  label: 'Shopify',
  syncFolderPath: 'shopify',
  pullDrafts: true,
  pullPublished: true,
  conflictStrategy: 'ask',
  syncMode: 'manual',
  adapter: {
    platform: 'shopify',
    shop: 'example-store.myshopify.com',
    accessToken: 'shpat_test',
  },
};

describe('desktop config target merge (non-destructive)', () => {
  it('synthesizes a single Ghost target only on the empty-targets first run', () => {
    const targets = mergeTargetsForConfig(undefined, base);
    expect(targets).toHaveLength(1);
    expect(targets[0].handle).toBe('ghost');
    expect(targets[0].adapter).toMatchObject({
      platform: 'ghost',
      ghostUrl: 'http://localhost:2368',
      adminApiKey: 'id:secret',
    });
    // First-run Ghost migrates to its base post kind.
    expect(targets[0].contentKinds).toEqual(['post']);
  });

  it('preserves an existing Shopify-only list — never prepends a phantom Ghost — and backfills contentKinds', () => {
    const targets = mergeTargetsForConfig([shopify], base);
    expect(targets).toHaveLength(1);
    // A legacy target (no contentKinds) is backfilled to the platform base kind.
    expect(targets[0]).toEqual({ ...shopify, contentKinds: ['article'] });
    expect(targets.some((t) => t.adapter.platform === 'ghost')).toBe(false);
  });

  it('preserves a multi-target list without dropping targets[1..N], normalizing contentKinds', () => {
    const ghost: TargetConfig = {
      handle: 'ghost',
      label: 'Ghost',
      syncFolderPath: '',
      pullDrafts: true,
      pullPublished: true,
      conflictStrategy: 'ask',
      syncMode: 'manual',
      contentKinds: ['post', 'page'],
      adapter: { platform: 'ghost', ghostUrl: 'https://a.example', adminApiKey: 'a:1' },
    };
    const ghost2: TargetConfig = {
      ...ghost,
      handle: 'b-example',
      contentKinds: [], // explicit "sync nothing" — preserved verbatim
      adapter: { platform: 'ghost', ghostUrl: 'https://b.example', adminApiKey: 'b:2' },
    };
    const targets = mergeTargetsForConfig([ghost, ghost2, shopify], base);
    expect(targets).toEqual([
      ghost,
      ghost2,
      { ...shopify, contentKinds: ['article'] },
    ]);
  });
});

describe('content-kind helpers (mirror the daemon)', () => {
  it('platformKinds offers each platform its kinds in the daemon order', () => {
    expect(platformKinds('ghost')).toEqual(['post', 'page']);
    expect(platformKinds('wordpress')).toEqual(['post', 'page']);
    expect(platformKinds('shopify')).toEqual(['article', 'page', 'product']);
  });

  it('baseKind is the platform base post kind', () => {
    expect(baseKind('ghost')).toBe('post');
    expect(baseKind('wordpress')).toBe('post');
    expect(baseKind('shopify')).toBe('article');
  });

  it('normalizeContentKinds: absent → base kind; present → filtered to supported', () => {
    const legacy = { ...shopify } as TargetConfig;
    delete (legacy as { contentKinds?: unknown }).contentKinds;
    expect(normalizeContentKinds(legacy)).toEqual(['article']);

    const filtered = { ...shopify, contentKinds: ['article', 'post'] } as TargetConfig;
    // 'post' isn't a Shopify kind — dropped.
    expect(normalizeContentKinds(filtered)).toEqual(['article']);

    const empty = { ...shopify, contentKinds: [] } as TargetConfig;
    expect(normalizeContentKinds(empty)).toEqual([]);
  });
});

describe('slugifyHandle', () => {
  it('lowercases, strips scheme, and collapses non-alphanumerics into single hyphens', () => {
    expect(slugifyHandle('https://Blog.Example.com')).toBe('blog-example-com');
    expect(slugifyHandle('My  Cool__Blog!!')).toBe('my-cool-blog');
    expect(slugifyHandle('store.myshopify.com')).toBe('store-myshopify-com');
  });

  it('trims leading/trailing hyphens so the handle matches ^[a-z0-9][a-z0-9-]*$', () => {
    const h = slugifyHandle('---@@@hello@@@---');
    expect(h).toBe('hello');
    expect(h).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it('falls back to "target" when nothing legal survives', () => {
    expect(slugifyHandle('@@@')).toBe('target');
    expect(slugifyHandle('')).toBe('target');
  });
});

describe('uniqueHandle', () => {
  it('returns the base when free', () => {
    expect(uniqueHandle('ghost', ['shopify-store'])).toBe('ghost');
  });

  it('appends -2, -3, … until the handle is unique', () => {
    expect(uniqueHandle('ghost', ['ghost'])).toBe('ghost-2');
    expect(uniqueHandle('ghost', ['ghost', 'ghost-2'])).toBe('ghost-3');
  });
});
