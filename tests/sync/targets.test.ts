/**
 * Multi-target config + routing tests (v0.4.0 Phase B).
 *
 * Three concerns covered:
 *  1. Legacy single-Ghost configs (every shipped user) auto-synthesize a
 *     single target on load — no migration step, no UX disruption.
 *  2. `effectiveRoot` collapses to the legacy `syncFolderPath` when there
 *     is exactly one target, and nests under `handle` when there are more.
 *     The collapse is what protects shipped users from a surprise file move.
 *  3. `routeToTarget` does longest-prefix matching so nested targets
 *     (`blog/posts` beats `blog`) win, and detects out-of-tree paths.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DaemonConfig,
  TargetConfig,
  loadConfig,
  saveConfig,
  synthesizeLegacyTarget,
  requireConfig,
} from '../../src/config.js';
import {
  effectiveRoot,
  routeAbsoluteToTarget,
  routeToTarget,
  targetSyncSettings,
} from '../../src/sync/targets.js';

describe('synthesizeLegacyTarget', () => {
  it('lifts legacy GhostSyncSettings into a Ghost TargetConfig', () => {
    const t = synthesizeLegacyTarget({
      ghostUrl: 'https://example.ghost.io',
      adminApiKey: 'abc:def',
      syncFolderPath: 'ghost-posts',
      pullDrafts: false,
      pullPublished: true,
      conflictStrategy: 'keep_local',
      syncMode: 'manual',
    });
    expect(t.handle).toBe('ghost');
    expect(t.label).toBe('Ghost');
    expect(t.syncFolderPath).toBe('ghost-posts');
    expect(t.pullDrafts).toBe(false);
    expect(t.pullPublished).toBe(true);
    expect(t.conflictStrategy).toBe('keep_local');
    expect(t.syncMode).toBe('manual');
    expect(t.adapter).toEqual({
      platform: 'ghost',
      ghostUrl: 'https://example.ghost.io',
      adminApiKey: 'abc:def',
    });
  });
});

describe('loadConfig / saveConfig with isolated XDG_CONFIG_HOME', () => {
  let tmpHome: string;
  let originalXdg: string | undefined;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ghost-sync-cfg-'));
    originalXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmpHome;
  });

  afterEach(async () => {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it('returns null when no config file exists yet', async () => {
    expect(await loadConfig()).toBeNull();
  });

  it('auto-synthesizes targets[0] from legacy fields when targets is absent', async () => {
    // Simulate what a shipped v0.3.x user has on disk — flat fields, no `targets`.
    const legacyOnDisk = {
      ghostUrl: 'https://blog.ghost.io',
      adminApiKey: 'id:secret',
      vaultPath: '/Users/x/vault',
      syncFolderPath: 'posts',
      pullDrafts: true,
      pullPublished: true,
      conflictStrategy: 'ask',
      syncMode: 'auto',
      watchDebounceMs: 2000,
    };
    await fs.mkdir(path.join(tmpHome, 'ghost-sync'), { recursive: true });
    await fs.writeFile(
      path.join(tmpHome, 'ghost-sync', 'config.json'),
      JSON.stringify(legacyOnDisk),
      'utf8',
    );
    const loaded = await loadConfig();
    expect(loaded).not.toBeNull();
    expect(loaded!.targets).toHaveLength(1);
    expect(loaded!.targets[0].handle).toBe('ghost');
    expect(loaded!.targets[0].adapter).toEqual({
      platform: 'ghost',
      ghostUrl: 'https://blog.ghost.io',
      adminApiKey: 'id:secret',
    });
    // Legacy fields preserved alongside — back-compat with any code that
    // still reads them directly.
    expect(loaded!.ghostUrl).toBe('https://blog.ghost.io');
  });

  it('returns empty targets[] when neither targets nor legacy creds are present', async () => {
    // A config file with only a vaultPath — not enough to derive a target.
    await fs.mkdir(path.join(tmpHome, 'ghost-sync'), { recursive: true });
    await fs.writeFile(
      path.join(tmpHome, 'ghost-sync', 'config.json'),
      JSON.stringify({ vaultPath: '/tmp/v' }),
      'utf8',
    );
    const loaded = await loadConfig();
    expect(loaded!.targets).toEqual([]);
  });

  it('preserves a hand-authored targets[] verbatim', async () => {
    const onDisk = {
      vaultPath: '/Users/x/vault',
      watchDebounceMs: 2000,
      targets: [
        {
          handle: 'blog-a',
          label: 'Blog A',
          syncFolderPath: '',
          pullDrafts: true,
          pullPublished: true,
          conflictStrategy: 'ask',
          syncMode: 'auto',
          adapter: {
            platform: 'ghost',
            ghostUrl: 'https://a.ghost.io',
            adminApiKey: 'aid:akey',
          },
        },
        {
          handle: 'shop',
          label: 'My Shopify Store',
          syncFolderPath: 'articles',
          pullDrafts: false,
          pullPublished: true,
          conflictStrategy: 'keep_remote',
          syncMode: 'manual',
          adapter: {
            platform: 'shopify',
            shop: 'my-store.myshopify.com',
            accessToken: 'shpat_xxx',
          },
        },
      ],
    };
    await fs.mkdir(path.join(tmpHome, 'ghost-sync'), { recursive: true });
    await fs.writeFile(
      path.join(tmpHome, 'ghost-sync', 'config.json'),
      JSON.stringify(onDisk),
      'utf8',
    );
    const loaded = await loadConfig();
    expect(loaded!.targets).toHaveLength(2);
    expect(loaded!.targets[0].handle).toBe('blog-a');
    expect(loaded!.targets[1].handle).toBe('shop');
    expect(loaded!.targets[1].adapter).toMatchObject({
      platform: 'shopify',
      shop: 'my-store.myshopify.com',
    });
  });

  it('round-trips an explicit targets[] through saveConfig + loadConfig', async () => {
    const cfg: DaemonConfig = {
      ghostUrl: '',
      adminApiKey: '',
      syncFolderPath: '',
      pullDrafts: true,
      pullPublished: true,
      conflictStrategy: 'ask',
      syncMode: 'auto',
      vaultPath: '/v',
      watchDebounceMs: 2000,
      targets: [
        {
          handle: 'one',
          label: 'One',
          syncFolderPath: 'a',
          pullDrafts: true,
          pullPublished: true,
          conflictStrategy: 'ask',
          syncMode: 'auto',
          adapter: { platform: 'ghost', ghostUrl: 'u1', adminApiKey: 'k1' },
        },
      ],
    };
    await saveConfig(cfg);
    const back = await loadConfig();
    expect(back!.targets).toEqual(cfg.targets);
  });
});

describe('requireConfig', () => {
  it('passes when targets[] has at least one entry and vaultPath is set', () => {
    const cfg: DaemonConfig = {
      ghostUrl: '',
      adminApiKey: '',
      syncFolderPath: '',
      pullDrafts: true,
      pullPublished: true,
      conflictStrategy: 'ask',
      syncMode: 'auto',
      vaultPath: '/v',
      watchDebounceMs: 2000,
      targets: [
        {
          handle: 'g',
          label: 'G',
          syncFolderPath: '',
          pullDrafts: true,
          pullPublished: true,
          conflictStrategy: 'ask',
          syncMode: 'auto',
          adapter: { platform: 'ghost', ghostUrl: 'u', adminApiKey: 'k' },
        },
      ],
    };
    expect(() => requireConfig(cfg)).not.toThrow();
  });

  it('throws when targets[] is empty', () => {
    const cfg: DaemonConfig = {
      ghostUrl: '',
      adminApiKey: '',
      syncFolderPath: '',
      pullDrafts: true,
      pullPublished: true,
      conflictStrategy: 'ask',
      syncMode: 'auto',
      vaultPath: '/v',
      watchDebounceMs: 2000,
      targets: [],
    };
    expect(() => requireConfig(cfg)).toThrow(/no sync targets/i);
  });

  it('throws when vaultPath is missing', () => {
    const cfg: DaemonConfig = {
      ghostUrl: '',
      adminApiKey: '',
      syncFolderPath: '',
      pullDrafts: true,
      pullPublished: true,
      conflictStrategy: 'ask',
      syncMode: 'auto',
      vaultPath: '',
      watchDebounceMs: 2000,
      targets: [
        {
          handle: 'g',
          label: 'G',
          syncFolderPath: '',
          pullDrafts: true,
          pullPublished: true,
          conflictStrategy: 'ask',
          syncMode: 'auto',
          adapter: { platform: 'ghost', ghostUrl: 'u', adminApiKey: 'k' },
        },
      ],
    };
    expect(() => requireConfig(cfg)).toThrow(/vaultPath/);
  });
});

describe('effectiveRoot', () => {
  const target = (overrides: Partial<TargetConfig> = {}): TargetConfig => ({
    handle: 'ghost',
    label: 'Ghost',
    syncFolderPath: 'posts',
    pullDrafts: true,
    pullPublished: true,
    conflictStrategy: 'ask',
    syncMode: 'auto',
    adapter: { platform: 'ghost', ghostUrl: 'u', adminApiKey: 'k' },
    ...overrides,
  });

  it('single-target: returns the bare syncFolderPath (no handle prefix)', () => {
    expect(effectiveRoot(target({ syncFolderPath: 'posts' }), false)).toBe('posts');
    expect(effectiveRoot(target({ syncFolderPath: '' }), false)).toBe('');
  });

  it('multi-target: prefixes with handle', () => {
    expect(effectiveRoot(target({ handle: 'a', syncFolderPath: 'posts' }), true)).toBe(
      'a/posts',
    );
  });

  it('multi-target with empty syncFolderPath: returns just the handle', () => {
    expect(effectiveRoot(target({ handle: 'a', syncFolderPath: '' }), true)).toBe('a');
  });
});

describe('routeToTarget', () => {
  const t = (handle: string, syncFolderPath = ''): TargetConfig => ({
    handle,
    label: handle,
    syncFolderPath,
    pullDrafts: true,
    pullPublished: true,
    conflictStrategy: 'ask',
    syncMode: 'auto',
    adapter: { platform: 'ghost', ghostUrl: 'u', adminApiKey: 'k' },
  });

  it('single-target with empty root matches everything', () => {
    const targets = [t('only', '')];
    expect(routeToTarget('whatever/anywhere.md', targets, false)?.handle).toBe('only');
  });

  it('single-target with syncFolderPath rejects files outside it', () => {
    const targets = [t('only', 'posts')];
    expect(routeToTarget('posts/x.md', targets, false)?.handle).toBe('only');
    expect(routeToTarget('other/x.md', targets, false)).toBeNull();
  });

  it('multi-target: longest-prefix wins', () => {
    const targets = [t('a', ''), t('b', 'posts')];
    // multi -> roots become 'a' and 'b/posts'
    expect(routeToTarget('a/somefile.md', targets, true)?.handle).toBe('a');
    expect(routeToTarget('b/posts/x.md', targets, true)?.handle).toBe('b');
  });

  it('multi-target: nested handles route correctly', () => {
    const targets = [t('blog', 'posts'), t('blog-archive', '')];
    expect(routeToTarget('blog/posts/x.md', targets, true)?.handle).toBe('blog');
    expect(routeToTarget('blog-archive/y.md', targets, true)?.handle).toBe('blog-archive');
  });

  it('returns null when the path is outside every target tree', () => {
    const targets = [t('a', 'one'), t('b', 'two')];
    expect(routeToTarget('three/x.md', targets, true)).toBeNull();
  });
});

describe('routeAbsoluteToTarget', () => {
  it('resolves an absolute path under the vault root to its target + relative path', async () => {
    const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'ghost-sync-route-'));
    try {
      const targets = [
        {
          handle: 'a',
          label: 'A',
          syncFolderPath: 'one',
          pullDrafts: true,
          pullPublished: true,
          conflictStrategy: 'ask' as const,
          syncMode: 'auto' as const,
          adapter: { platform: 'ghost' as const, ghostUrl: 'u', adminApiKey: 'k' },
        },
      ];
      const abs = path.join(vault, 'one', 'note.md');
      const route = routeAbsoluteToTarget(abs, vault, targets, false);
      expect(route?.target.handle).toBe('a');
      expect(route?.relPath).toBe('one/note.md');
    } finally {
      await fs.rm(vault, { recursive: true, force: true });
    }
  });

  it('returns null when the path is outside the vault', () => {
    const targets = [
      {
        handle: 'a',
        label: 'A',
        syncFolderPath: '',
        pullDrafts: true,
        pullPublished: true,
        conflictStrategy: 'ask' as const,
        syncMode: 'auto' as const,
        adapter: { platform: 'ghost' as const, ghostUrl: 'u', adminApiKey: 'k' },
      },
    ];
    expect(
      routeAbsoluteToTarget('/etc/passwd', '/tmp/some-vault', targets, false),
    ).toBeNull();
  });
});

describe('targetSyncSettings', () => {
  it('projects a target into engine-visible settings using effectiveRoot', () => {
    const target: TargetConfig = {
      handle: 'h',
      label: 'H',
      syncFolderPath: 'posts',
      pullDrafts: false,
      pullPublished: true,
      conflictStrategy: 'keep_local',
      syncMode: 'manual',
      adapter: { platform: 'ghost', ghostUrl: 'u', adminApiKey: 'k' },
    };
    // multi-target case nests under the handle.
    const multi = targetSyncSettings(target, true);
    expect(multi.syncFolderPath).toBe('h/posts');
    expect(multi.pullDrafts).toBe(false);
    expect(multi.conflictStrategy).toBe('keep_local');
    expect(multi.syncMode).toBe('manual');
    // ghostUrl/adminApiKey are vestigial in the GhostSyncSettings interface;
    // the engine no longer reads them — adapter is injected separately.
    expect(multi.ghostUrl).toBe('');
    expect(multi.adminApiKey).toBe('');

    // single-target collapses to the bare syncFolderPath.
    const single = targetSyncSettings(target, false);
    expect(single.syncFolderPath).toBe('posts');
  });
});
