import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SyncEngine } from '../../src/sync/engine.js';
import { Vault } from '../../src/vault.js';
import { DEFAULT_SETTINGS, GhostSyncSettings } from '../../src/types.js';
import { parsePostContent, serializePostContent } from '../../src/utils/frontmatter.js';
import { markdownToLexical } from '../../src/ghost/api.js';
import { FakeGhostApi, makeGhostPost } from '../fakes/FakeGhostApi.js';
import { makeTmpVault, readFile, writeFile } from '../fakes/tmpVault.js';

function settings(overrides: Partial<GhostSyncSettings> = {}): GhostSyncSettings {
  // Empty syncFolderPath = vault root IS the sync folder. Keeps fixtures shallow.
  return { ...DEFAULT_SETTINGS, syncFolderPath: '', ...overrides };
}

describe('SyncEngine.pull', () => {
  let vault: Vault;
  let root: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ vault, root, cleanup } = await makeTmpVault());
  });

  afterEach(async () => {
    await cleanup();
  });

  it('creates a new local file when Ghost has a post we do not', async () => {
    const api = new FakeGhostApi().seed([
      makeGhostPost({
        id: 'p1',
        slug: 'hello-world',
        title: 'Hello World',
        status: 'published',
        lexical: markdownToLexical('# Hello World\n\nFirst post.'),
      }),
    ]);
    const engine = new SyncEngine(vault, api.adapter(), settings());

    const result = await engine.pull();

    expect(result.created).toEqual(['Hello World']);
    expect(result.updated).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.errors).toEqual([]);

    const content = await readFile(root, 'hello-world.md');
    const parsed = parsePostContent(content);
    expect(parsed.frontmatter.ghost_id).toBe('p1');
    expect(parsed.frontmatter.ghost_slug).toBe('hello-world');
    expect(parsed.frontmatter.ghost_status).toBe('published');
    expect(parsed.title).toBe('Hello World');
  });

  it('creates a local page file with cms.kind=page when Ghost has a page we do not', async () => {
    const api = new FakeGhostApi();
    await api.createPage({
      title: 'About',
      status: 'published',
      lexical: markdownToLexical('# About\n\nCompany page.'),
    });
    const engine = new SyncEngine(vault, api.adapter(), settings());

    const result = await engine.pull();

    expect(result.created).toEqual(['About']);

    const content = await readFile(root, 'about.md');
    const parsed = parsePostContent(content);
    expect(parsed.frontmatter.cms_kind).toBe('page');
    expect(parsed.frontmatter.ghost_id).toBeTruthy();
    expect(parsed.title).toBe('About');
    expect(content).toContain('kind: page');
  });

  it('skips when local + Ghost are already in sync (idempotent)', async () => {
    // Seed a Ghost post whose updated_at matches what we stored locally.
    const updatedAt = '2026-05-19T10:00:00.000Z';
    const post = makeGhostPost({
      id: 'p1',
      slug: 'in-sync',
      title: 'In Sync',
      status: 'published',
      updated_at: updatedAt,
      lexical: markdownToLexical('# In Sync\n\nUnchanged body.'),
    });
    const api = new FakeGhostApi().seed([post]);

    // Write the corresponding local file as if it had been synced already.
    const local = serializePostContent(
      {
        ghost_id: 'p1',
        ghost_slug: 'in-sync',
        ghost_status: 'published',
        ghost_updated_at: updatedAt,
        // local_updated_at far in the future so hasLocalChanges returns false
        // regardless of when the test file's mtime lands.
        local_updated_at: '2099-01-01T00:00:00.000Z',
        tags: [],
        feature_image: null,
        excerpt: null,
      },
      'In Sync',
      'Unchanged body.',
    );
    await writeFile(root, 'in-sync.md', local);

    const engine = new SyncEngine(vault, api.adapter(), settings());
    const result = await engine.pull();

    expect(result.skipped).toEqual(['In Sync']);
    expect(result.created).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it('flags a conflict when both sides changed since last sync', async () => {
    // Local file's recorded ghost_updated_at is OLD.
    const oldGhostUpdatedAt = '2026-05-01T00:00:00.000Z';
    const newGhostUpdatedAt = '2026-05-19T12:00:00.000Z';
    // local_updated_at is in the past → file mtime will exceed it → hasLocalChanges true.
    const localUpdatedAt = '2026-05-10T00:00:00.000Z';

    const local = serializePostContent(
      {
        ghost_id: 'p1',
        ghost_slug: 'conflicted',
        ghost_status: 'published',
        ghost_updated_at: oldGhostUpdatedAt,
        local_updated_at: localUpdatedAt,
        tags: [],
        feature_image: null,
        excerpt: null,
      },
      'Conflicted',
      'Local edit happened after the last sync.',
    );
    const relPath = 'conflicted.md';
    await writeFile(root, relPath, local);
    // Force mtime to "now" so it's well past localUpdatedAt + 1s buffer.
    const abs = path.join(root, relPath);
    const now = new Date();
    await fs.utimes(abs, now, now);

    const api = new FakeGhostApi().seed([
      makeGhostPost({
        id: 'p1',
        slug: 'conflicted',
        title: 'Conflicted',
        status: 'published',
        updated_at: newGhostUpdatedAt,
        lexical: markdownToLexical('# Conflicted\n\nGhost edit happened too.'),
      }),
    ]);

    const engine = new SyncEngine(vault, api.adapter(), settings({ conflictStrategy: 'ask' }));
    const result = await engine.pull();

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].type).toBe('both_modified');
    expect(result.conflicts[0].ghostPost.id).toBe('p1');
    expect(result.updated).toEqual([]);
    // Local file should be untouched on conflict.
    const still = await readFile(root, relPath);
    expect(still).toContain('Local edit happened after the last sync.');
  });
});
