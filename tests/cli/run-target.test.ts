/**
 * `--target <handle>` flag + per-target state.json writes (v0.5.1).
 *
 * Three concerns covered:
 *  1. `selectTargets` filters config.targets to one handle, or throws a
 *     well-formed error on an unknown handle. This is the contract the CLI
 *     surface depends on; the `--target` flag short-circuits before any
 *     adapter is constructed.
 *  2. `runOnce(...)` with `target: <handle>` only touches that one target —
 *     proven by mocking `createAdapter` and asserting the others' adapters
 *     are never constructed.
 *  3. After each per-target operation the engine writes a `state.targets`
 *     entry for that handle. The global counters (`lastPulled`, `lastPushed`)
 *     are preserved, and a multi-target run produces one entry per target.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DaemonConfig,
  TargetConfig,
  loadState,
  saveConfig,
} from '../../src/config.js';
import { FakeGhostApi, makeGhostPost } from '../fakes/FakeGhostApi.js';
import { markdownToLexical } from '../../src/ghost/api.js';
import { GhostAdapter } from '../../src/ghost/adapter.js';
import type { CmsAdapter } from '../../src/cms/adapter.js';
import { selectTargets } from '../../src/cli/run.js';

// `createAdapter` is mocked per-test below — vitest hoists vi.mock so the
// factory is patched before the SUT loads. The implementation is rewired in
// `beforeEach` because each test needs a fresh FakeGhostApi.
vi.mock('../../src/cms/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/cms/index.js')>(
    '../../src/cms/index.js',
  );
  return {
    ...actual,
    createAdapter: vi.fn(actual.createAdapter),
  };
});

// `notify` (osascript / zenity / Win) does nothing useful in the test
// environment; silence it so tests don't shell out.
vi.mock('../../src/notify.js', () => ({ notify: vi.fn() }));

async function setupTmpDirs(): Promise<{
  tmpConfig: string;
  tmpState: string;
  vaultPath: string;
  cleanup: () => Promise<void>;
}> {
  const tmpConfig = await fs.mkdtemp(path.join(os.tmpdir(), 'specter-run-cfg-'));
  const tmpState = await fs.mkdtemp(path.join(os.tmpdir(), 'specter-run-state-'));
  const vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), 'specter-run-vault-'));
  const prevCfg = process.env.XDG_CONFIG_HOME;
  const prevState = process.env.XDG_STATE_HOME;
  process.env.XDG_CONFIG_HOME = tmpConfig;
  process.env.XDG_STATE_HOME = tmpState;
  return {
    tmpConfig,
    tmpState,
    vaultPath,
    cleanup: async () => {
      if (prevCfg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevCfg;
      if (prevState === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = prevState;
      for (const dir of [tmpConfig, tmpState, vaultPath]) {
        try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    },
  };
}

function makeTarget(handle: string, overrides: Partial<TargetConfig> = {}): TargetConfig {
  return {
    handle,
    label: handle,
    syncFolderPath: '',
    pullDrafts: true,
    pullPublished: true,
    conflictStrategy: 'ask',
    syncMode: 'auto',
    adapter: {
      platform: 'ghost',
      ghostUrl: `https://${handle}.example.ghost.io`,
      adminApiKey: 'id:key',
    },
    ...overrides,
  };
}

function makeConfig(vaultPath: string, targets: TargetConfig[]): DaemonConfig {
  return {
    ghostUrl: '',
    adminApiKey: '',
    syncFolderPath: '',
    pullDrafts: true,
    pullPublished: true,
    conflictStrategy: 'ask',
    syncMode: 'auto',
    vaultPath,
    watchDebounceMs: 2000,
    targets,
  };
}

describe('selectTargets', () => {
  const targets = [makeTarget('ghost'), makeTarget('shop')];

  it('returns the full list when handle is undefined', () => {
    expect(selectTargets(targets, undefined)).toEqual(targets);
  });

  it('returns just the matching target', () => {
    const picked = selectTargets(targets, 'shop');
    expect(picked).toHaveLength(1);
    expect(picked[0].handle).toBe('shop');
  });

  it('throws a well-formed error on an unknown handle', () => {
    expect(() => selectTargets(targets, 'nope')).toThrow(
      /no target with handle "nope"/,
    );
  });
});

describe('runOnce with --target', () => {
  let dirs: Awaited<ReturnType<typeof setupTmpDirs>>;
  let ghostFake: FakeGhostApi;
  let shopFake: FakeGhostApi;

  beforeEach(async () => {
    dirs = await setupTmpDirs();

    // Two distinct fake APIs, each seeded with one post so we can tell which
    // one was actually called by inspecting createCount/updateCount.
    ghostFake = new FakeGhostApi().seed([
      makeGhostPost({
        id: 'g1',
        slug: 'ghost-post',
        title: 'Ghost Post',
        status: 'published',
        lexical: markdownToLexical('# Ghost Post\n\nFrom Ghost.'),
      }),
    ]);
    shopFake = new FakeGhostApi().seed([
      makeGhostPost({
        id: 's1',
        slug: 'shop-post',
        title: 'Shop Post',
        status: 'published',
        lexical: markdownToLexical('# Shop Post\n\nFrom Shop.'),
      }),
    ]);

    // Wire createAdapter to return the fake matching the target handle.
    const { createAdapter } = await import('../../src/cms/index.js');
    vi.mocked(createAdapter).mockImplementation((cfg) => {
      const adapter: CmsAdapter =
        cfg.platform === 'ghost' && cfg.ghostUrl.includes('shop')
          ? new GhostAdapter(shopFake)
          : new GhostAdapter(ghostFake);
      return adapter;
    });
  });

  afterEach(async () => {
    await dirs.cleanup();
    vi.clearAllMocks();
  });

  it('only pulls from the matched target (others are skipped)', async () => {
    const config = makeConfig(dirs.vaultPath, [
      makeTarget('ghost'),
      makeTarget('shop', {
        adapter: {
          platform: 'ghost',
          ghostUrl: 'https://shop.example.ghost.io',
          adminApiKey: 'id:key',
        },
      }),
    ]);
    await saveConfig(config);

    const { runOnce } = await import('../../src/cli/run.js');
    const outcome = await runOnce('pull', { silent: true, target: 'ghost' });

    expect('pulled' in outcome).toBe(true);
    if (!('pulled' in outcome)) throw new Error('unreachable');
    // Only the ghost target ran — one create from the seeded `g1`.
    expect(outcome.pulled).toBe(1);
    // Multi-target layout: the ghost target's file lives under `ghost/`.
    const ghostDir = path.join(dirs.vaultPath, 'ghost');
    const ghostEntries = await fs.readdir(ghostDir);
    expect(ghostEntries.filter((f) => f.endsWith('.md'))).toHaveLength(1);
    // The shop folder should not exist because the shop target was skipped.
    await expect(fs.access(path.join(dirs.vaultPath, 'shop'))).rejects.toThrow();
    // Per-target state should ONLY have an entry for ghost, not shop.
    const state = await loadState();
    expect(state.targets?.ghost).toBeDefined();
    expect(state.targets?.shop).toBeUndefined();
  });

  it('exits non-zero (throws) when handle does not match any target', async () => {
    const config = makeConfig(dirs.vaultPath, [makeTarget('ghost')]);
    await saveConfig(config);

    const { runOnce } = await import('../../src/cli/run.js');
    await expect(
      runOnce('pull', { silent: true, target: 'nope' }),
    ).rejects.toThrow(/no target with handle "nope"/);
  });

  it('dry-run respects --target', async () => {
    const config = makeConfig(dirs.vaultPath, [
      makeTarget('ghost'),
      makeTarget('shop', {
        adapter: {
          platform: 'ghost',
          ghostUrl: 'https://shop.example.ghost.io',
          adminApiKey: 'id:key',
        },
      }),
    ]);
    await saveConfig(config);

    const { runOnce } = await import('../../src/cli/run.js');
    const plan = await runOnce('pull', { silent: true, dryRun: true, target: 'shop' });
    if ('pulled' in plan) throw new Error('expected SyncPlan');
    // Only the shop target's post should appear in the plan creates. The plan
    // carries the filename (slug-derived), not the post title — that's what
    // the DryRunVault sees at create time.
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0].localPath).toContain('shop-post.md');
  });
});

describe('per-target state.json writes', () => {
  let dirs: Awaited<ReturnType<typeof setupTmpDirs>>;
  let ghostFake: FakeGhostApi;
  let shopFake: FakeGhostApi;

  beforeEach(async () => {
    dirs = await setupTmpDirs();

    ghostFake = new FakeGhostApi().seed([
      makeGhostPost({
        id: 'g1',
        slug: 'g-one',
        title: 'G One',
        status: 'published',
        lexical: markdownToLexical('# G One\n\nBody.'),
      }),
    ]);
    shopFake = new FakeGhostApi().seed([
      makeGhostPost({
        id: 's1',
        slug: 's-one',
        title: 'S One',
        status: 'published',
        lexical: markdownToLexical('# S One\n\nBody.'),
      }),
      makeGhostPost({
        id: 's2',
        slug: 's-two',
        title: 'S Two',
        status: 'published',
        lexical: markdownToLexical('# S Two\n\nBody.'),
      }),
    ]);

    const { createAdapter } = await import('../../src/cms/index.js');
    vi.mocked(createAdapter).mockImplementation((cfg) => {
      if (cfg.platform === 'ghost' && cfg.ghostUrl.includes('shop')) {
        return new GhostAdapter(shopFake);
      }
      return new GhostAdapter(ghostFake);
    });
  });

  afterEach(async () => {
    await dirs.cleanup();
    vi.clearAllMocks();
  });

  it('writes per-target metrics after a pull across two targets', async () => {
    const config = makeConfig(dirs.vaultPath, [
      makeTarget('ghost'),
      makeTarget('shop', {
        adapter: {
          platform: 'ghost',
          ghostUrl: 'https://shop.example.ghost.io',
          adminApiKey: 'id:key',
        },
      }),
    ]);
    await saveConfig(config);

    const { runOnce } = await import('../../src/cli/run.js');
    await runOnce('pull', { silent: true });

    const state = await loadState();
    expect(state.targets).toBeDefined();
    expect(state.targets!.ghost).toBeDefined();
    expect(state.targets!.shop).toBeDefined();

    expect(state.targets!.ghost.lastPullCount).toBe(1);
    expect(state.targets!.ghost.lastPushCount).toBe(0);
    expect(state.targets!.ghost.lastSyncStatus).toBe('ok');
    expect(state.targets!.ghost.lastSyncAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(state.targets!.ghost.lastError).toBeNull();

    expect(state.targets!.shop.lastPullCount).toBe(2);
    expect(state.targets!.shop.lastPushCount).toBe(0);
    expect(state.targets!.shop.lastSyncStatus).toBe('ok');

    // Global counters reflect the sum across targets, untouched by this change.
    expect(state.lastPulled).toBe(3);
  });

  it('preserves per-target entries when a later run only touches one target', async () => {
    const config = makeConfig(dirs.vaultPath, [
      makeTarget('ghost'),
      makeTarget('shop', {
        adapter: {
          platform: 'ghost',
          ghostUrl: 'https://shop.example.ghost.io',
          adminApiKey: 'id:key',
        },
      }),
    ]);
    await saveConfig(config);

    const { runOnce } = await import('../../src/cli/run.js');
    // First run: both targets touched.
    await runOnce('pull', { silent: true });
    const after1 = await loadState();
    const shopFirstAt = after1.targets!.shop.lastSyncAt;
    expect(shopFirstAt).toBeTruthy();

    // Second run: only --target ghost. Shop entry must NOT be wiped.
    await runOnce('pull', { silent: true, target: 'ghost' });
    const after2 = await loadState();
    // Pull is idempotent — same fake state, so nothing new to pull.
    expect(after2.targets!.ghost.lastPullCount).toBe(0);
    // Shop entry's timestamp is unchanged from the first run.
    expect(after2.targets!.shop.lastSyncAt).toBe(shopFirstAt);
    expect(after2.targets!.shop.lastPullCount).toBe(2);
  });

  it('writes per-target metrics after a push (single-target config)', async () => {
    const config = makeConfig(dirs.vaultPath, [makeTarget('ghost')]);
    await saveConfig(config);

    // Write a local file that will be pushed as a new post. Use the existing
    // frontmatter serializer to construct it.
    const { serializePostContent } = await import('../../src/utils/frontmatter.js');
    const md = serializePostContent(
      {
        ghost_id: null,
        ghost_slug: null,
        ghost_status: 'draft',
        ghost_updated_at: null,
        local_updated_at: null,
        tags: [],
        feature_image: null,
        excerpt: null,
      },
      'Fresh Draft',
      'Body of the fresh draft.',
    );
    await fs.writeFile(path.join(dirs.vaultPath, 'fresh-draft.md'), md, 'utf8');

    const { runOnce } = await import('../../src/cli/run.js');
    await runOnce('push', { silent: true });

    const state = await loadState();
    expect(state.targets).toBeDefined();
    expect(state.targets!.ghost).toBeDefined();
    expect(state.targets!.ghost.lastPushCount).toBe(1);
    expect(state.targets!.ghost.lastSyncStatus).toBe('ok');
    expect(state.targets!.ghost.lastConflicts).toBe(0);
  });
});
