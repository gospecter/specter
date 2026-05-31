/**
 * Exercises the multi-target upsert/remove surface in desktop/src/main/config.ts.
 *
 * config.ts reaches the filesystem through ./paths.js (which imports `electron`),
 * so we mock both: `electron` to a stub `app`, and `node:fs`/`fs` to an
 * in-memory store keyed by path. This lets us assert the on-disk config.json
 * shape after each upsert without an Electron runtime.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory filesystem keyed by absolute path.
const files = new Map<string, string>();

vi.mock('electron', () => ({
  app: { isPackaged: false },
}));

vi.mock('fs', () => {
  const mod = {
    constants: { R_OK: 4 },
    existsSync: (p: string) => files.has(p),
    mkdirSync: () => undefined,
    accessSync: (p: string) => {
      if (!files.has(p)) throw new Error('ENOENT');
    },
    readFileSync: (p: string) => {
      if (!files.has(p)) throw new Error('ENOENT');
      return files.get(p)!;
    },
    writeFileSync: (p: string, body: string) => {
      files.set(p, body);
    },
    renameSync: (from: string, to: string) => {
      files.set(to, files.get(from)!);
      files.delete(from);
    },
    unlinkSync: (p: string) => {
      files.delete(p);
    },
    chmodSync: () => undefined,
  };
  return { ...mod, default: mod };
});

// Force a deterministic, non-win32 platform for path resolution + chmod paths.
Object.defineProperty(process, 'platform', { value: 'linux' });

import {
  readConfig,
  writeConfig,
  upsertGhostTarget,
  upsertWordPressTarget,
  upsertShopifyTarget,
  removeTarget,
  setTargetContentKinds,
} from '../../desktop/src/main/config';
import { configFilePath } from '../../desktop/src/main/paths';

const CONFIG_PATH = configFilePath();

function seedBaseConfig(): void {
  files.clear();
  // A first-run Ghost config (single target synthesized from flat fields).
  writeConfig({
    ghostUrl: 'https://blog-one.example.com',
    adminApiKey: 'one:secret',
    vaultPath: '/tmp/vault',
    syncFolderPath: '',
    pullDrafts: true,
    pullPublished: true,
    conflictStrategy: 'ask',
    syncMode: 'manual',
    watchDebounceMs: 2000,
  });
}

function onDiskTargets() {
  return readConfig()?.targets ?? [];
}

beforeEach(() => {
  seedBaseConfig();
});

describe('upsertGhostTarget', () => {
  it('seeds a single Ghost target with handle "ghost" on first run', () => {
    const targets = onDiskTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0].adapter.platform).toBe('ghost');
  });

  it('adds a 2nd Ghost blog with a unique slugified handle and its own empty folder', () => {
    upsertGhostTarget('https://blog-two.example.com', 'two:secret', 'Blog Two');
    const targets = onDiskTargets();
    expect(targets).toHaveLength(2);

    const second = targets[1];
    expect(second.adapter.platform).toBe('ghost');
    expect(second.adapter.ghostUrl).toBe('https://blog-two.example.com');
    expect(second.label).toBe('Blog Two');
    // Unique handle, never the literal "ghost", and folder left empty so the
    // daemon isolates it under its own handle/ directory.
    expect(second.handle).not.toBe('ghost');
    expect(second.handle).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(second.syncFolderPath).toBe('');

    // The first Ghost target is untouched.
    expect(targets[0].adapter.ghostUrl).toBe('https://blog-one.example.com');
  });

  it('updates an existing Ghost blog in place (same handle) when host matches', () => {
    upsertGhostTarget('https://blog-two.example.com', 'two:secret');
    const handleBefore = onDiskTargets()[1].handle;
    upsertGhostTarget('https://blog-two.example.com/', 'two:rotated', 'Renamed');
    const targets = onDiskTargets();
    expect(targets).toHaveLength(2);
    expect(targets[1].handle).toBe(handleBefore);
    expect(targets[1].adapter.adminApiKey).toBe('two:rotated');
    expect(targets[1].label).toBe('Renamed');
  });
});

describe('handle + folder isolation across platforms', () => {
  it('two Shopify stores get distinct handles and distinct empty folders (no shared "shopify")', () => {
    upsertShopifyTarget('store-a.myshopify.com', 'shpat_a');
    upsertShopifyTarget('store-b.myshopify.com', 'shpat_b');
    const shops = onDiskTargets().filter((t) => t.adapter.platform === 'shopify');
    expect(shops).toHaveLength(2);
    const handles = shops.map((t) => t.handle);
    expect(new Set(handles).size).toBe(2);
    shops.forEach((t) => expect(t.syncFolderPath).toBe(''));
  });

  it('keeps every platform target — Ghost + WordPress + Shopify coexist', () => {
    upsertWordPressTarget('https://wp.example.com', 'admin', 'app pass word');
    upsertShopifyTarget('store-a.myshopify.com', 'shpat_a');
    upsertGhostTarget('https://blog-two.example.com', 'two:secret');
    const targets = onDiskTargets();
    const platforms = targets.map((t) => t.adapter.platform).sort();
    expect(platforms).toEqual(['ghost', 'ghost', 'shopify', 'wordpress']);
    // All handles unique.
    const handles = targets.map((t) => t.handle);
    expect(new Set(handles).size).toBe(handles.length);
  });
});

describe('writeConfig preserves all targets through a legacy flat save', () => {
  it('a legacy single-Ghost save (no targets field) keeps targets[1..N]', () => {
    upsertWordPressTarget('https://wp.example.com', 'admin', 'app pass word');
    expect(onDiskTargets()).toHaveLength(2);

    // Simulate the legacy Settings window: flat fields, no `targets`.
    writeConfig({
      ghostUrl: 'https://blog-one.example.com',
      adminApiKey: 'one:rotated',
      vaultPath: '/tmp/vault',
      syncFolderPath: '',
      pullDrafts: true,
      pullPublished: true,
      conflictStrategy: 'ask',
      syncMode: 'auto',
      watchDebounceMs: 2000,
    });

    const targets = onDiskTargets();
    expect(targets).toHaveLength(2);
    // Ghost target[0] picked up the rotated key…
    expect(targets[0].adapter.adminApiKey).toBe('one:rotated');
    // …and the WordPress target survived the legacy save.
    expect(targets.some((t) => t.adapter.platform === 'wordpress')).toBe(true);
  });
});

describe('removeTarget', () => {
  it('splices a target out and preserves the rest', () => {
    upsertWordPressTarget('https://wp.example.com', 'admin', 'app pass word');
    const wpHandle = onDiskTargets().find((t) => t.adapter.platform === 'wordpress')!.handle;

    const result = removeTarget(wpHandle);
    expect(result.ok).toBe(true);

    const targets = onDiskTargets();
    expect(targets.some((t) => t.handle === wpHandle)).toBe(false);
    expect(targets.some((t) => t.adapter.platform === 'ghost')).toBe(true);
  });

  it('returns an error for an unknown handle', () => {
    const result = removeTarget('does-not-exist');
    expect(result.ok).toBe(false);
  });

  it('removing the last target leaves an empty targets list (no re-synthesized Ghost)', () => {
    const ghostHandle = onDiskTargets()[0].handle;
    const result = removeTarget(ghostHandle);
    expect(result.ok).toBe(true);
    expect(onDiskTargets()).toHaveLength(0);
  });
});

describe('contentKinds — opt-in selection', () => {
  it('first-run synthesized Ghost target normalizes to base kind ["post"]', () => {
    // seedBaseConfig wrote a legacy flat Ghost config (no contentKinds).
    expect(onDiskTargets()[0].contentKinds).toEqual(['post']);
  });

  it('a NEW Ghost blog persists exactly the chosen contentKinds', () => {
    upsertGhostTarget('https://blog-two.example.com', 'two:secret', 'Blog Two', ['post', 'page']);
    const second = onDiskTargets()[1];
    expect(second.contentKinds).toEqual(['post', 'page']);
  });

  it('a NEW Ghost blog with no selection opts into NOTHING (empty array)', () => {
    upsertGhostTarget('https://blog-three.example.com', 'three:secret', 'Three');
    const t = onDiskTargets().find(
      (x) => x.adapter.ghostUrl === 'https://blog-three.example.com',
    )!;
    expect(t.contentKinds).toEqual([]);
  });

  it('a NEW WordPress site persists the chosen contentKinds and filters unsupported kinds', () => {
    // 'product' is Shopify-only — it must be filtered out for WordPress.
    upsertWordPressTarget('https://wp.example.com', 'admin', 'app pass word', 'WP', [
      'page',
      'product',
    ]);
    const wp = onDiskTargets().find((t) => t.adapter.platform === 'wordpress')!;
    expect(wp.contentKinds).toEqual(['page']);
  });

  it('a NEW Shopify store (OAuth, no form) defaults to base kind ["article"]', () => {
    upsertShopifyTarget('store-a.myshopify.com', 'shpat_a');
    const shop = onDiskTargets().find((t) => t.adapter.platform === 'shopify')!;
    expect(shop.contentKinds).toEqual(['article']);
  });

  it('editing a target changes its contentKinds, preserving the rest', () => {
    upsertGhostTarget('https://blog-two.example.com', 'two:secret', 'Blog Two', ['post']);
    const handle = onDiskTargets().find(
      (t) => t.adapter.ghostUrl === 'https://blog-two.example.com',
    )!.handle;

    const result = setTargetContentKinds(handle, ['post', 'page']);
    expect(result.ok).toBe(true);

    const edited = onDiskTargets().find((t) => t.handle === handle)!;
    expect(edited.contentKinds).toEqual(['post', 'page']);
    // The synthesized Ghost target[0] is untouched.
    expect(onDiskTargets()[0].contentKinds).toEqual(['post']);
  });

  it('setTargetContentKinds accepts an empty array ("sync nothing")', () => {
    const handle = onDiskTargets()[0].handle;
    const result = setTargetContentKinds(handle, []);
    expect(result.ok).toBe(true);
    expect(onDiskTargets()[0].contentKinds).toEqual([]);
  });

  it('setTargetContentKinds returns an error for an unknown handle', () => {
    expect(setTargetContentKinds('nope', ['post']).ok).toBe(false);
  });

  it('a legacy target on disk WITHOUT contentKinds normalizes to base kind on read', () => {
    // Simulate a config.json written by an older build: targets without the
    // field. Write it raw, bypassing the upsert helpers.
    const cfg = readConfig()!;
    const raw = {
      ...cfg,
      targets: [
        {
          handle: 'legacy-wp',
          label: 'Legacy WP',
          syncFolderPath: '',
          pullDrafts: true,
          pullPublished: true,
          conflictStrategy: 'ask',
          syncMode: 'manual',
          // NOTE: no contentKinds field.
          adapter: { platform: 'wordpress', siteUrl: 'https://old.example.com', username: 'u', appPassword: 'p' },
        },
      ],
    };
    files.set(CONFIG_PATH, JSON.stringify(raw, null, 2) + '\n');

    const legacy = onDiskTargets().find((t) => t.handle === 'legacy-wp')!;
    expect(legacy.contentKinds).toEqual(['post']); // WordPress base kind
  });
});
