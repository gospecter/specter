import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SyncEngine } from '../../src/sync/engine.js';
import { Vault } from '../../src/vault.js';
import { DEFAULT_SETTINGS, GhostSyncSettings } from '../../src/types.js';
import { parsePostContent, serializePostContent } from '../../src/utils/frontmatter.js';
import { lexicalToMarkdown, markdownToLexical } from '../../src/ghost/api.js';
import { FakeGhostApi, makeGhostPost } from '../fakes/FakeGhostApi.js';
import { makeTmpVault, readFile, writeFile } from '../fakes/tmpVault.js';

function settings(overrides: Partial<GhostSyncSettings> = {}): GhostSyncSettings {
  return { ...DEFAULT_SETTINGS, syncFolderPath: '', ...overrides };
}

describe('SyncEngine.push', () => {
  let vault: Vault;
  let root: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ vault, root, cleanup } = await makeTmpVault());
  });

  afterEach(async () => {
    await cleanup();
  });

  it('creates a Ghost post for a local file with no ghost_id', async () => {
    const local = serializePostContent(
      {
        ghost_id: null,
        ghost_slug: null,
        ghost_status: 'draft',
        ghost_updated_at: null,
        local_updated_at: null,
        tags: ['new', 'draft'],
        feature_image: null,
        excerpt: 'A fresh draft.',
      },
      'Brand New Draft',
      'Body of the draft post.',
    );
    await writeFile(root, 'brand-new-draft.md', local);

    const api = new FakeGhostApi();
    const engine = new SyncEngine(vault, api.adapter(), settings());

    const result = await engine.push();

    expect(result.created).toEqual(['Brand New Draft']);
    expect(result.updated).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(api.createCount).toBe(1);
    expect(api.snapshot()).toHaveLength(1);

    // Local file should now carry the new ghost_id.
    const updated = parsePostContent(await readFile(root, 'brand-new-draft.md'));
    expect(updated.frontmatter.ghost_id).toBeTruthy();
    expect(updated.frontmatter.ghost_status).toBe('draft');
    expect(updated.frontmatter.local_updated_at).toBeTruthy();
  });

  it('creates a Ghost page for a local file with cms.kind=page and no ghost_id', async () => {
    const local = serializePostContent(
      {
        cms_kind: 'page',
        ghost_id: null,
        ghost_slug: null,
        ghost_status: 'draft',
        ghost_updated_at: null,
        local_updated_at: null,
        tags: ['page'],
        feature_image: null,
        excerpt: 'A fresh page.',
      },
      'About Us',
      'Body of the page.',
      { platform: 'ghost', kind: 'page' },
    );
    await writeFile(root, 'about-us.md', local);

    const api = new FakeGhostApi();
    const engine = new SyncEngine(vault, api.adapter(), settings());

    const result = await engine.push();

    expect(result.created).toEqual(['About Us']);
    expect(result.updated).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(api.snapshot()).toHaveLength(0);
    expect(api.snapshotPages()).toHaveLength(1);

    const updated = parsePostContent(await readFile(root, 'about-us.md'));
    expect(updated.frontmatter.cms_kind).toBe('page');
    expect(updated.frontmatter.ghost_id).toBeTruthy();
  });

  it('uploads local markdown images before creating a remote post', async () => {
    await fs.mkdir(path.join(root, 'assets'), { recursive: true });
    await fs.writeFile(path.join(root, 'assets', 'cover.png'), 'fake image bytes');

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
      'Image Post',
      'Before\n\n![Cover](assets/cover.png)\n\nAfter',
    );
    await writeFile(root, 'image-post.md', local);

    const api = new FakeGhostApi();
    const engine = new SyncEngine(vault, api.adapter(), settings());

    const result = await engine.push();

    expect(result.created).toEqual(['Image Post']);
    expect(api.uploadImageCount).toBe(1);
    const remoteMarkdown = lexicalToMarkdown(api.snapshot()[0].lexical);
    expect(remoteMarkdown).toContain('https://fake.invalid/content/images/cover.png');

    const updated = parsePostContent(await readFile(root, 'image-post.md'));
    expect(updated.content).toContain('https://fake.invalid/content/images/cover.png');
    expect(updated.content).not.toContain('assets/cover.png');
  });

  it('uploads a local feature_image before creating a remote post', async () => {
    await fs.mkdir(path.join(root, 'assets'), { recursive: true });
    await fs.writeFile(path.join(root, 'assets', 'hero.jpg'), 'fake image bytes');

    const local = serializePostContent(
      {
        ghost_id: null,
        ghost_slug: null,
        ghost_status: 'draft',
        ghost_updated_at: null,
        local_updated_at: null,
        tags: [],
        feature_image: 'assets/hero.jpg',
        excerpt: null,
      },
      'Feature Image Post',
      'Body.',
    );
    await writeFile(root, 'feature-image-post.md', local);

    const api = new FakeGhostApi();
    const engine = new SyncEngine(vault, api.adapter(), settings());

    const result = await engine.push();

    expect(result.created).toEqual(['Feature Image Post']);
    expect(api.uploadImageCount).toBe(1);
    expect(api.snapshot()[0].feature_image).toBe('https://fake.invalid/content/images/hero.jpg');

    const updated = parsePostContent(await readFile(root, 'feature-image-post.md'));
    expect(updated.frontmatter.feature_image).toBe('https://fake.invalid/content/images/hero.jpg');
  });

  it('updates an existing Ghost post when local is newer', async () => {
    const initialGhostUpdatedAt = '2026-05-10T00:00:00.000Z';
    const oldLocalUpdatedAt = '2026-05-10T00:00:00.000Z';
    const post = makeGhostPost({
      id: 'p1',
      slug: 'editme',
      title: 'Edit Me',
      status: 'published',
      updated_at: initialGhostUpdatedAt,
      lexical: markdownToLexical('# Edit Me\n\nOriginal.'),
    });
    const api = new FakeGhostApi().seed([post]);

    const local = serializePostContent(
      {
        ghost_id: 'p1',
        ghost_slug: 'editme',
        ghost_status: 'published',
        ghost_updated_at: initialGhostUpdatedAt,
        local_updated_at: oldLocalUpdatedAt,
        tags: [],
        feature_image: null,
        excerpt: null,
      },
      'Edit Me',
      'Local edit.',
    );
    const relPath = 'editme.md';
    await writeFile(root, relPath, local);
    // Bump mtime so hasLocalChanges fires.
    const abs = path.join(root, relPath);
    const now = new Date();
    await fs.utimes(abs, now, now);

    const engine = new SyncEngine(vault, api.adapter(), settings());
    const result = await engine.push();

    expect(result.updated).toEqual(['Edit Me']);
    expect(result.created).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(api.updateCount).toBe(1);
    // updated_at should have advanced.
    expect(api.snapshot()[0].updated_at).not.toBe(initialGhostUpdatedAt);

    // Local frontmatter's ghost_updated_at should now reflect the new server time.
    const after = parsePostContent(await readFile(root, relPath));
    expect(after.frontmatter.ghost_updated_at).toBe(api.snapshot()[0].updated_at);
  });

  it('skips unchanged synced files', async () => {
    const initialGhostUpdatedAt = '2026-05-10T00:00:00.000Z';
    const post = makeGhostPost({
      id: 'p1',
      slug: 'untouched',
      title: 'Untouched',
      status: 'published',
      updated_at: initialGhostUpdatedAt,
      lexical: markdownToLexical('# Untouched\n\nSame.'),
    });
    const api = new FakeGhostApi().seed([post]);

    const local = serializePostContent(
      {
        ghost_id: 'p1',
        ghost_slug: 'untouched',
        ghost_status: 'published',
        ghost_updated_at: initialGhostUpdatedAt,
        // local_updated_at far in the future so hasLocalChanges is false.
        local_updated_at: '2099-01-01T00:00:00.000Z',
        tags: [],
        feature_image: null,
        excerpt: null,
      },
      'Untouched',
      'Same.',
    );
    await writeFile(root, 'untouched.md', local);

    const engine = new SyncEngine(vault, api.adapter(), settings());
    const result = await engine.push();

    expect(result.skipped).toEqual(['Untouched']);
    expect(result.updated).toEqual([]);
    expect(api.updateCount).toBe(0);
    expect(api.createCount).toBe(0);
  });

  it('respects maxUploads: creates up to the cap and defers the rest', async () => {
    // Five brand-new local posts, cap of 2 uploads.
    for (let i = 1; i <= 5; i++) {
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
        `Post ${i}`,
        `Body ${i}.`,
      );
      await writeFile(root, `post-${i}.md`, local);
    }

    const api = new FakeGhostApi();
    const engine = new SyncEngine(vault, api.adapter(), settings());

    const result = await engine.push(2);

    expect(result.created).toHaveLength(2);
    expect(result.deferred).toHaveLength(3);
    expect(api.createCount).toBe(2);
    // Posts not yet uploaded must not have been mutated locally.
    expect(api.snapshot()).toHaveLength(2);
  });

  it('respects maxUploads=0: defers everything, uploads nothing', async () => {
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
      'Solo',
      'Body.',
    );
    await writeFile(root, 'solo.md', local);

    const api = new FakeGhostApi();
    const engine = new SyncEngine(vault, api.adapter(), settings());

    const result = await engine.push(0);

    expect(result.created).toEqual([]);
    expect(result.deferred).toEqual(['Solo']);
    expect(api.createCount).toBe(0);
  });

  it('maxUploads does not consume the cap on no-op skips', async () => {
    // A post with ghost_id and no local changes — would be skipped anyway.
    // Plus one fresh post that should still upload despite a small cap.
    const skipMe = serializePostContent(
      {
        ghost_id: 'p1',
        ghost_slug: 'p1',
        ghost_status: 'published',
        ghost_updated_at: '2026-05-01T00:00:00.000Z',
        local_updated_at: '2099-01-01T00:00:00.000Z',
        tags: [],
        feature_image: null,
        excerpt: null,
      },
      'Skip Me',
      'unchanged',
    );
    const uploadMe = serializePostContent(
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
      'Upload Me',
      'fresh',
    );
    await writeFile(root, 'skip-me.md', skipMe);
    await writeFile(root, 'upload-me.md', uploadMe);

    const api = new FakeGhostApi();
    const engine = new SyncEngine(vault, api.adapter(), settings());

    const result = await engine.push(1);

    expect(result.skipped).toEqual(['Skip Me']);
    expect(result.created).toEqual(['Upload Me']);
    expect(result.deferred).toEqual([]);
  });
});
