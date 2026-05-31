/**
 * Tests for the multi-target management + validation layer that lets a user
 * add as many CMS connections as they like (any platform, repeated platforms).
 *
 * Covers the invariants saveConfig/requireConfig enforce:
 *  - handle slugification + uniqueness
 *  - validateTargets rejects duplicate handles, bad handle format, and two
 *    targets resolving to the same folder
 *  - upsertTarget/removeTarget behave non-destructively
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DaemonConfig,
  HANDLE_RE,
  TargetConfig,
  defaultHandleBase,
  ensureUniqueHandle,
  loadConfig,
  removeTarget,
  requireConfig,
  saveConfig,
  slugifyHandle,
  upsertTarget,
  validateTargets,
} from '../../src/config.js';
import { DEFAULT_SETTINGS } from '../../src/types.js';
import { AdapterConfig } from '../../src/cms/types.js';

const ghost = (url: string): AdapterConfig => ({
  platform: 'ghost',
  ghostUrl: url,
  adminApiKey: 'id:secret',
});

const target = (handle: string, over: Partial<TargetConfig> = {}): TargetConfig => ({
  handle,
  label: handle,
  syncFolderPath: '',
  pullDrafts: true,
  pullPublished: true,
  conflictStrategy: 'ask',
  syncMode: 'auto',
  adapter: ghost(`https://${handle}.ghost.io`),
  ...over,
});

describe('slugifyHandle', () => {
  it('strips scheme, lowercases, and hyphenates a host', () => {
    expect(slugifyHandle('https://My-Blog.Ghost.io')).toBe('my-blog-ghost-io');
  });
  it('collapses runs of non-alphanumerics and trims hyphens', () => {
    expect(slugifyHandle('  Hello,  World!! ')).toBe('hello-world');
  });
  it('always produces a HANDLE_RE-valid handle', () => {
    for (const input of ['https://x.com', 'Two Words', '...', 'café-blög', '99 bottles']) {
      expect(HANDLE_RE.test(slugifyHandle(input))).toBe(true);
    }
  });
  it('falls back to "target" when nothing usable remains', () => {
    expect(slugifyHandle('!!!')).toBe('target');
  });
});

describe('ensureUniqueHandle', () => {
  it('returns the slugified base when free', () => {
    expect(ensureUniqueHandle('My Blog', [])).toBe('my-blog');
  });
  it('suffixes -2, -3 when the base is taken', () => {
    expect(ensureUniqueHandle('ghost', ['ghost'])).toBe('ghost-2');
    expect(ensureUniqueHandle('ghost', ['ghost', 'ghost-2'])).toBe('ghost-3');
  });
});

describe('defaultHandleBase', () => {
  it('uses the host/shop per platform', () => {
    expect(defaultHandleBase(ghost('https://a.ghost.io'))).toBe('https://a.ghost.io');
    expect(
      defaultHandleBase({ platform: 'shopify', shop: 'my-store.myshopify.com', accessToken: 't' }),
    ).toBe('my-store.myshopify.com');
    expect(
      defaultHandleBase({ platform: 'wordpress', siteUrl: 'https://wp.com', username: 'u', appPassword: 'p' }),
    ).toBe('https://wp.com');
  });
});

describe('validateTargets', () => {
  it('accepts two Ghost blogs with distinct handles', () => {
    expect(() => validateTargets([target('blog-a'), target('blog-b')])).not.toThrow();
  });
  it('accepts mixed platforms', () => {
    expect(() =>
      validateTargets([
        target('myghost'),
        target('mystore', { adapter: { platform: 'shopify', shop: 's.myshopify.com', accessToken: 't' } }),
        target('mywp', { adapter: { platform: 'wordpress', siteUrl: 'https://wp.com', username: 'u', appPassword: 'p' } }),
      ]),
    ).not.toThrow();
  });
  it('rejects a duplicate handle', () => {
    expect(() => validateTargets([target('dup'), target('dup')])).toThrow(/[Dd]uplicate/);
  });
  it('rejects an invalid handle format', () => {
    expect(() => validateTargets([target('Bad Handle')])).toThrow(/[Ii]nvalid/);
    expect(() => validateTargets([target('../escape')])).toThrow(/[Ii]nvalid/);
  });
  it('allows two targets with the same syncFolderPath because the handle prefixes it', () => {
    // In multi-target mode effectiveRoot is `handle/syncFolderPath`, so distinct
    // handles → distinct folders even when syncFolderPath matches. This is the
    // folder-isolation guarantee.
    expect(() =>
      validateTargets([
        target('a', { syncFolderPath: 'posts' }),
        target('b', { syncFolderPath: 'posts' }),
      ]),
    ).not.toThrow();
  });
  it('does not flag a single target with an empty folder', () => {
    expect(() => validateTargets([target('only', { syncFolderPath: '' })])).not.toThrow();
  });
});

describe('upsertTarget', () => {
  it('appends a new target', () => {
    const out = upsertTarget([target('a')], target('b'));
    expect(out.map((t) => t.handle)).toEqual(['a', 'b']);
  });
  it('replaces in place by handle', () => {
    const out = upsertTarget([target('a', { label: 'old' }), target('b')], target('a', { label: 'new' }));
    expect(out.map((t) => t.handle)).toEqual(['a', 'b']);
    expect(out.find((t) => t.handle === 'a')?.label).toBe('new');
  });
  it('does not mutate the input array', () => {
    const input = [target('a')];
    upsertTarget(input, target('b'));
    expect(input).toHaveLength(1);
  });
  it('throws when replacing would introduce a duplicate handle is impossible, but appending an invalid handle is caught', () => {
    expect(() => upsertTarget([target('a')], target('Bad Handle'))).toThrow(/[Ii]nvalid/);
  });
});

describe('removeTarget', () => {
  it('removes by handle', () => {
    expect(removeTarget([target('a'), target('b')], 'a').map((t) => t.handle)).toEqual(['b']);
  });
  it('throws when no target matches', () => {
    expect(() => removeTarget([target('a')], 'nope')).toThrow(/No target/);
  });
  it('does not mutate the input', () => {
    const input = [target('a'), target('b')];
    removeTarget(input, 'a');
    expect(input).toHaveLength(2);
  });
});

describe('requireConfig enforces target validity', () => {
  const base = (targets: TargetConfig[]): DaemonConfig => ({
    ...DEFAULT_SETTINGS,
    vaultPath: '/tmp/vault',
    watchDebounceMs: 2000,
    targets,
  });
  it('accepts a valid multi-target config', () => {
    expect(() => requireConfig(base([target('a'), target('b')]))).not.toThrow();
  });
  it('rejects a hand-edited config with duplicate handles', () => {
    expect(() => requireConfig(base([target('dup'), target('dup')]))).toThrow(/[Dd]uplicate/);
  });
});

describe('saveConfig / loadConfig round-trip for many targets', () => {
  let tmpHome: string;
  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-targets-'));
    process.env.XDG_CONFIG_HOME = path.join(tmpHome, 'config');
    process.env.XDG_STATE_HOME = path.join(tmpHome, 'state');
  });
  afterEach(async () => {
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_STATE_HOME;
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it('persists and reloads four targets across three platforms', async () => {
    const targets: TargetConfig[] = [
      target('blog-one'),
      target('blog-two'),
      target('store', { adapter: { platform: 'shopify', shop: 's.myshopify.com', accessToken: 't' } }),
      target('news', { adapter: { platform: 'wordpress', siteUrl: 'https://wp.com', username: 'u', appPassword: 'p' } }),
    ];
    const config: DaemonConfig = {
      ...DEFAULT_SETTINGS,
      vaultPath: '/tmp/vault',
      watchDebounceMs: 2000,
      targets,
    };
    await saveConfig(config);
    const loaded = await loadConfig();
    expect(loaded?.targets.map((t) => t.handle)).toEqual(['blog-one', 'blog-two', 'store', 'news']);
    expect(loaded?.targets.map((t) => t.adapter.platform)).toEqual([
      'ghost',
      'ghost',
      'shopify',
      'wordpress',
    ]);
  });

  it('saveConfig refuses to write a config with a duplicate handle', async () => {
    const config: DaemonConfig = {
      ...DEFAULT_SETTINGS,
      vaultPath: '/tmp/vault',
      watchDebounceMs: 2000,
      targets: [target('dup'), target('dup')],
    };
    await expect(saveConfig(config)).rejects.toThrow(/[Dd]uplicate/);
  });
});
