import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SyncEngine } from '../../src/sync/engine.js';
import { DryRunAdapter, DryRunVault, emptyPlan } from '../../src/sync/dryrun.js';
import { DEFAULT_SETTINGS, GhostSyncSettings } from '../../src/types.js';
import { serializePostContent } from '../../src/utils/frontmatter.js';
import { markdownToLexical } from '../../src/ghost/api.js';
import { FakeGhostApi, makeGhostPost } from '../fakes/FakeGhostApi.js';
import { makeTmpVault, listFiles, readFile, writeFile } from '../fakes/tmpVault.js';

function settings(overrides: Partial<GhostSyncSettings> = {}): GhostSyncSettings {
  return { ...DEFAULT_SETTINGS, syncFolderPath: '', ...overrides };
}

/**
 * The dry-run module exports adapters that wrap Vault / CmsAdapter.
 * `DryRunVault` extends `Vault` but its overrides intercept writes — the
 * underlying disk is only touched for read-through calls. We point it at a
 * real (empty) tmp directory so super.read / super.listMarkdownFiles can
 * see the fixtures we set up. `DryRunAdapter` wraps a real `CmsAdapter`
 * (here, the FakeGhostApi behind a GhostAdapter) and intercepts mutations.
 */

describe('Dry-run', () => {
  let root: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ root, cleanup } = await makeTmpVault());
  });

  afterEach(async () => {
    await cleanup();
  });

  it('produces a non-empty plan when there are remote changes to pull', async () => {
    const api = new FakeGhostApi().seed([
      makeGhostPost({
        id: 'p1',
        slug: 'remote-only',
        title: 'Remote Only',
        status: 'published',
        lexical: markdownToLexical('# Remote Only\n\nBody.'),
      }),
    ]);
    const plan = emptyPlan('pull');
    const vault = new DryRunVault(root, plan);
    const dryAdapter = new DryRunAdapter(api.adapter(), plan);
    const engine = new SyncEngine(vault, dryAdapter, settings());

    await engine.pull();

    expect(plan.creates).toHaveLength(1);
    // DryRunVault.create() only sees the filename (slug), not the post title.
    // That's fine — the localPath carries enough info for the UI.
    expect(plan.creates[0].localPath).toBe('remote-only.md');
    expect(plan.creates[0].side).toBe('local');
  });

  it('produces zero side effects on disk', async () => {
    const api = new FakeGhostApi().seed([
      makeGhostPost({
        id: 'p1',
        slug: 'pretend-create',
        title: 'Pretend Create',
        status: 'published',
        lexical: markdownToLexical('# Pretend Create\n\nBody.'),
      }),
    ]);
    const plan = emptyPlan('pull');
    const vault = new DryRunVault(root, plan);
    const dryAdapter = new DryRunAdapter(api.adapter(), plan);
    const engine = new SyncEngine(vault, dryAdapter, settings());

    await engine.pull();

    // The dry-run should have recorded a create — but the file must not exist.
    expect(plan.creates).toHaveLength(1);
    const files = await listFiles(root);
    expect(files).toEqual([]);
  });

  it('produces zero side effects on the Ghost API', async () => {
    // Local file with no ghost_id → push would normally create a Ghost post.
    const local = serializePostContent(
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
      'Dry Run Push',
      'Body.',
    );
    await writeFile(root, 'dry-run-push.md', local);

    const api = new FakeGhostApi();
    const plan = emptyPlan('push');
    const vault = new DryRunVault(root, plan);
    const dryAdapter = new DryRunAdapter(api.adapter(), plan);
    const engine = new SyncEngine(vault, dryAdapter, settings());

    await engine.push();

    // Plan records the would-be remote create.
    expect(plan.creates.some((e) => e.side === 'remote')).toBe(true);
    // But the underlying api never received any mutating call.
    expect(api.createCount).toBe(0);
    expect(api.updateCount).toBe(0);
    expect(api.deleteCount).toBe(0);
    expect(api.snapshot()).toHaveLength(0);
  });

  it('buckets sync-metadata-only writes separately from content updates', async () => {
    // Local file already has ghost_id — push will hit updateLocalFrontmatter,
    // which writes the same body with new metadata. DryRunVault should label
    // that as a metadataUpdate, not a regular update.
    const initialGhostUpdatedAt = '2026-05-10T00:00:00.000Z';
    const post = makeGhostPost({
      id: 'p1',
      slug: 'meta-only',
      title: 'Meta Only',
      status: 'published',
      updated_at: initialGhostUpdatedAt,
      lexical: markdownToLexical('# Meta Only\n\nSame body.'),
    });
    const api = new FakeGhostApi().seed([post]);

    const local = serializePostContent(
      {
        ghost_id: 'p1',
        ghost_slug: 'meta-only',
        ghost_status: 'published',
        ghost_updated_at: initialGhostUpdatedAt,
        local_updated_at: '2026-05-10T00:00:00.000Z',
        tags: [],
        feature_image: null,
        excerpt: null,
      },
      'Meta Only',
      'Same body.',
    );
    const relPath = 'meta-only.md';
    await writeFile(root, relPath, local);
    // Force mtime so the engine treats it as locally modified.
    const abs = path.join(root, relPath);
    const now = new Date();
    await fs.utimes(abs, now, now);

    const plan = emptyPlan('push');
    const vault = new DryRunVault(root, plan);
    const dryAdapter = new DryRunAdapter(api.adapter(), plan);
    const engine = new SyncEngine(vault, dryAdapter, settings());

    await engine.push();

    // The remote update is recorded as a real update; the local frontmatter
    // refresh that follows is a metadata-only write.
    expect(plan.updates.some((e) => e.side === 'remote')).toBe(true);
    expect(plan.metadataUpdates.length).toBeGreaterThanOrEqual(1);
    expect(plan.metadataUpdates.every((e) => e.side === 'local')).toBe(true);

    // And of course the real api is still untouched.
    expect(api.updateCount).toBe(0);
  });
});

// (DryRunAdapter wraps a real CmsAdapter directly — no per-call rebinding
//  needed. The Ghost-side reads pass through fake.adapter() into FakeGhostApi.)
