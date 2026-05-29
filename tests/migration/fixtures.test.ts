/**
 * Migration golden fixtures (v0.4.0 Phase C — dual-write frontmatter).
 *
 * The `before/` directory holds files exactly as they appear on disk in
 * shipped v0.3.x vaults — legacy `ghost_*` frontmatter only. The `after/`
 * directory holds the byte-exact result of running them through the v0.4.0
 * serializer (dual v1 + v2 emission).
 *
 * Why golden files instead of inline strings: YAML's whitespace + quoting
 * choices are subtle, and a regression in the writer is easier to spot when
 * the diff is human-readable. Regenerate by running with `UPDATE_GOLDEN=1`.
 *
 * Each case asserts three invariants:
 *   1. Migration is correct: before → writer → matches after exactly.
 *   2. Migration is idempotent: after → writer → matches after (no further drift).
 *   3. Migration is lossless: parse(before) === parse(after) in-memory.
 *
 * Together these guarantee that the engine touching a v1 file once promotes
 * it to v1+v2 and never touches it again on subsequent reads.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Platform } from '../../src/cms/types.js';
import {
  parsePostContent,
  serializePostContent,
} from '../../src/utils/frontmatter.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BEFORE_DIR = path.join(HERE, 'before');
const AFTER_DIR = path.join(HERE, 'after');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

// Per-file context the writer needs. The `before/` filename can't carry the
// platform discriminator, so it's listed here explicitly — keeps the test
// deterministic without requiring the file content itself to track it.
const CASES: { file: string; platform: Platform }[] = [
  { file: 'ghost-published-with-tags.md', platform: 'ghost' },
  { file: 'ghost-draft-minimal.md', platform: 'ghost' },
  { file: 'unsynced-local.md', platform: 'ghost' },
  { file: 'shopify-article.md', platform: 'shopify' },
  { file: 'wordpress-post.md', platform: 'wordpress' },
];

beforeAll(async () => {
  // Materialize golden `after/` files on first run (or when UPDATE_GOLDEN=1).
  // After the initial commit, this only runs as a no-op for existing files.
  await fs.mkdir(AFTER_DIR, { recursive: true });
  for (const { file, platform } of CASES) {
    const afterPath = path.join(AFTER_DIR, file);
    const exists = await fileExists(afterPath);
    if (exists && !UPDATE) continue;
    const before = await fs.readFile(path.join(BEFORE_DIR, file), 'utf8');
    const parsed = parsePostContent(before);
    const migrated = serializePostContent(parsed.frontmatter, parsed.title, parsed.content, {
      platform,
    });
    await fs.writeFile(afterPath, migrated, 'utf8');
  }
});

describe('Migration golden fixtures (v0.3.x → v0.4.0 dual-write)', () => {
  for (const { file, platform } of CASES) {
    describe(file, () => {
      it('before → writer === after (golden migration is exact)', async () => {
        const before = await fs.readFile(path.join(BEFORE_DIR, file), 'utf8');
        const after = await fs.readFile(path.join(AFTER_DIR, file), 'utf8');
        const parsed = parsePostContent(before);
        const migrated = serializePostContent(
          parsed.frontmatter,
          parsed.title,
          parsed.content,
          { platform },
        );
        expect(migrated).toEqual(after);
      });

      it('after → writer === after (re-serializing is idempotent)', async () => {
        const after = await fs.readFile(path.join(AFTER_DIR, file), 'utf8');
        const parsed = parsePostContent(after);
        const reserialized = serializePostContent(
          parsed.frontmatter,
          parsed.title,
          parsed.content,
          { platform },
        );
        expect(reserialized).toEqual(after);
      });

      it('parse(before) and parse(after) yield the same in-memory state', async () => {
        const before = await fs.readFile(path.join(BEFORE_DIR, file), 'utf8');
        const after = await fs.readFile(path.join(AFTER_DIR, file), 'utf8');
        const a = parsePostContent(before);
        const b = parsePostContent(after);
        expect(b.frontmatter).toEqual(a.frontmatter);
        expect(b.title).toEqual(a.title);
        expect(b.content).toEqual(a.content);
      });
    });
  }

  it('synced files gain a `cms:` block; unsynced files do not', async () => {
    // Spot-check the dual-write semantics on real fixtures: posts that have
    // a remote identity get the canonical v2 block; bare local drafts stay
    // bare so they don't grow synthetic metadata before they're pushed.
    const synced = await fs.readFile(
      path.join(AFTER_DIR, 'ghost-published-with-tags.md'),
      'utf8',
    );
    expect(synced).toContain('cms:');
    expect(synced).toContain('platform: ghost');

    const unsynced = await fs.readFile(
      path.join(AFTER_DIR, 'unsynced-local.md'),
      'utf8',
    );
    expect(unsynced).not.toContain('cms:');
    expect(unsynced).not.toContain('ghost_id:');
  });

  it('Shopify file emits platform: shopify (not ghost)', async () => {
    const shopify = await fs.readFile(path.join(AFTER_DIR, 'shopify-article.md'), 'utf8');
    expect(shopify).toContain('platform: shopify');
    expect(shopify).not.toContain('platform: ghost');
    // The Shopify gid lives unchanged in `ghost_id` — the v1 field is
    // platform-agnostic in this codebase even though its name says "ghost".
    // YAML quotes the gid because of the `://` (URI-like value); the parser
    // strips the quotes on read, so the in-memory value is identical.
    expect(shopify).toContain("id: 'gid://shopify/Article/9876543210'");
    expect(shopify).toContain("ghost_id: 'gid://shopify/Article/9876543210'");
  });

  it('downgrade safety: an after-file still satisfies a v0.3.x reader (ghost_* keys intact)', async () => {
    // Simulate a user rolling back to v0.3.x — their reader only knows the
    // legacy keys. The migrated file must still carry them.
    const after = await fs.readFile(
      path.join(AFTER_DIR, 'ghost-published-with-tags.md'),
      'utf8',
    );
    expect(after).toContain('ghost_id:');
    expect(after).toContain('ghost_slug:');
    expect(after).toContain('ghost_status:');
    expect(after).toContain('ghost_updated_at:');
  });
});

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
