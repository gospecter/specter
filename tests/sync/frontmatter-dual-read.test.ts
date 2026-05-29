import { describe, expect, it } from 'vitest';
import { parsePostContent, serializePostContent } from '../../src/utils/frontmatter.js';

describe('Frontmatter dual-read (v0.3.2)', () => {
  describe('legacy v1 shape (currently shipped)', () => {
    it('reads ghost_* fields from a shipped-user file', () => {
      const raw = [
        '---',
        'ghost_id: abc123',
        'ghost_slug: my-post',
        'ghost_status: published',
        'ghost_updated_at: 2026-05-24T12:00:00.000Z',
        'local_updated_at: 2026-05-24T13:00:00.000Z',
        'tags:',
        '  - foo',
        '  - bar',
        'feature_image: https://cdn/x.jpg',
        'excerpt: A summary.',
        '---',
        '',
        '# My Post',
        '',
        'Body here.',
      ].join('\n');
      const parsed = parsePostContent(raw);
      expect(parsed.frontmatter.ghost_id).toBe('abc123');
      expect(parsed.frontmatter.ghost_slug).toBe('my-post');
      expect(parsed.frontmatter.ghost_status).toBe('published');
      expect(parsed.frontmatter.ghost_updated_at).toBe('2026-05-24T12:00:00.000Z');
      expect(parsed.frontmatter.tags).toEqual(['foo', 'bar']);
      expect(parsed.frontmatter.feature_image).toBe('https://cdn/x.jpg');
      expect(parsed.title).toBe('My Post');
      expect(parsed.content).toBe('Body here.');
    });

    it('round-trips through serialize → parse unchanged (v1)', () => {
      const original = parsePostContent(
        ['---', 'ghost_id: x', 'ghost_status: draft', 'tags:', '  - a', '---', '', '# T', '', 'B'].join('\n'),
      );
      const written = serializePostContent(original.frontmatter, original.title, original.content);
      const reparsed = parsePostContent(written);
      expect(reparsed.frontmatter.ghost_id).toBe('x');
      expect(reparsed.frontmatter.ghost_status).toBe('draft');
      expect(reparsed.frontmatter.tags).toEqual(['a']);
    });
  });

  describe('new v2 cms-block shape (will be written by v0.4.0+)', () => {
    it('reads cms.* block as the primary source', () => {
      const raw = [
        '---',
        'cms:',
        '  platform: ghost',
        '  kind: page',
        '  id: abc123',
        '  slug: my-post',
        '  status: published',
        '  updated_at: 2026-05-24T12:00:00.000Z',
        'local_updated_at: 2026-05-24T13:00:00.000Z',
        'tags:',
        '  - foo',
        '---',
        '',
        '# My Post',
        '',
        'Body.',
      ].join('\n');
      const parsed = parsePostContent(raw);
      expect(parsed.frontmatter.cms_kind).toBe('page');
      expect(parsed.frontmatter.ghost_id).toBe('abc123');
      expect(parsed.frontmatter.ghost_slug).toBe('my-post');
      expect(parsed.frontmatter.ghost_status).toBe('published');
      expect(parsed.frontmatter.ghost_updated_at).toBe('2026-05-24T12:00:00.000Z');
      expect(parsed.frontmatter.tags).toEqual(['foo']);
    });

    it('cms block for shopify platform also parses (forward-compat)', () => {
      const raw = [
        '---',
        'cms:',
        '  platform: shopify',
        '  id: gid://shopify/Article/42',
        '  slug: my-article',
        '  status: published',
        '  updated_at: 2026-05-24T12:00:00.000Z',
        '---',
        '',
        '# T',
        '',
        'B',
      ].join('\n');
      const parsed = parsePostContent(raw);
      expect(parsed.frontmatter.ghost_id).toBe('gid://shopify/Article/42');
      expect(parsed.frontmatter.ghost_slug).toBe('my-article');
    });
  });

  describe('mixed / dual', () => {
    it('prefers cms.* over legacy ghost_* when both are present', () => {
      const raw = [
        '---',
        'ghost_id: legacy-id',
        'ghost_slug: legacy-slug',
        'cms:',
        '  platform: ghost',
        '  id: new-id',
        '  slug: new-slug',
        '  status: draft',
        '  updated_at: 2026-05-24T12:00:00.000Z',
        '---',
        '',
        '# T',
      ].join('\n');
      const parsed = parsePostContent(raw);
      expect(parsed.frontmatter.ghost_id).toBe('new-id');
      expect(parsed.frontmatter.ghost_slug).toBe('new-slug');
    });

    it('falls back to legacy when cms block is incomplete', () => {
      const raw = [
        '---',
        'ghost_id: legacy-id',
        'ghost_slug: legacy-slug',
        'cms:',
        '  platform: ghost',
        '  status: draft',
        '---',
        '',
        '# T',
      ].join('\n');
      const parsed = parsePostContent(raw);
      // cms.id missing → legacy ghost_id wins for that field
      expect(parsed.frontmatter.ghost_id).toBe('legacy-id');
      // cms.status present → wins over default
      expect(parsed.frontmatter.ghost_status).toBe('draft');
    });

    it('survives malformed cms block (not an object)', () => {
      const raw = [
        '---',
        'cms: "this is a string, not an object"',
        'ghost_id: fallback',
        '---',
        '',
        '# T',
      ].join('\n');
      const parsed = parsePostContent(raw);
      expect(parsed.frontmatter.ghost_id).toBe('fallback');
    });
  });

  describe('parse is idempotent across v1 → v2 → v1', () => {
    it('reading either shape yields the same in-memory representation', () => {
      const v1 = parsePostContent(
        [
          '---',
          'ghost_id: abc',
          'ghost_slug: s',
          'ghost_status: published',
          'ghost_updated_at: 2026-05-24T12:00:00.000Z',
          'local_updated_at: 2026-05-24T13:00:00.000Z',
          'tags:',
          '  - t1',
          '---',
          '',
          '# Title',
          '',
          'Body',
        ].join('\n'),
      );
      const v2 = parsePostContent(
        [
          '---',
          'cms:',
          '  platform: ghost',
          '  id: abc',
          '  slug: s',
          '  status: published',
          '  updated_at: 2026-05-24T12:00:00.000Z',
          'local_updated_at: 2026-05-24T13:00:00.000Z',
          'tags:',
          '  - t1',
          '---',
          '',
          '# Title',
          '',
          'Body',
        ].join('\n'),
      );
      expect(v2.frontmatter).toEqual(v1.frontmatter);
      expect(v2.title).toEqual(v1.title);
      expect(v2.content).toEqual(v1.content);
    });
  });

  describe('writer (v0.4.0+ dual-write — both v1 and v2 keys emitted)', () => {
    const baseFrontmatter = {
      ghost_id: 'abc',
      ghost_slug: 's',
      ghost_status: 'published' as const,
      ghost_updated_at: '2026-05-24T12:00:00.000Z',
      local_updated_at: '2026-05-24T13:00:00.000Z',
      tags: ['x'],
      feature_image: null,
      excerpt: null,
    };

    it('emits both ghost_* keys AND a cms block (default platform=ghost)', () => {
      const out = serializePostContent(baseFrontmatter, 'T', 'B');
      // v1 mirror — keeps shipped v0.3.x readers happy.
      expect(out).toContain('ghost_id: abc');
      expect(out).toContain('ghost_slug: s');
      // v2 canonical block.
      expect(out).toContain('cms:');
      expect(out).toContain('platform: ghost');
      expect(out).not.toContain('kind: post');
      expect(out).toContain('id: abc');
    });

    it('emits kind: page when serializing a page', () => {
      const out = serializePostContent(baseFrontmatter, 'T', 'B', {
        platform: 'ghost',
        kind: 'page',
      });
      expect(out).toContain('kind: page');
    });

    it('emits platform: shopify when the adapter is Shopify', () => {
      const out = serializePostContent(baseFrontmatter, 'T', 'B', { platform: 'shopify' });
      expect(out).toContain('platform: shopify');
      // The shopify gid lives in `ghost_id` on disk (the legacy field name
      // is opaque to the engine — id can be any string).
      expect(out).toContain('ghost_id: abc');
    });

    it('omits the cms block entirely when ghost_id is null (unsynced post)', () => {
      // A file the user is drafting locally — no remote identity yet.
      const out = serializePostContent(
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
        'Untitled',
        'Drafting...',
      );
      expect(out).not.toContain('cms:');
      expect(out).not.toContain('ghost_id:');
    });

    it('keeps cms.kind for an unsynced page draft', () => {
      const out = serializePostContent(
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
        'About',
        'Drafting...',
        { platform: 'ghost', kind: 'page' },
      );
      expect(out).toContain('cms:');
      expect(out).toContain('kind: page');
      expect(out).not.toContain('ghost_id:');

      const parsed = parsePostContent(out);
      expect(parsed.frontmatter.cms_kind).toBe('page');
      expect(parsed.frontmatter.ghost_id).toBeNull();
    });

    it('write → read → write is idempotent (byte-identical second write)', () => {
      const first = serializePostContent(baseFrontmatter, 'My Post', 'Body content here.');
      const parsed = parsePostContent(first);
      const second = serializePostContent(parsed.frontmatter, parsed.title, parsed.content);
      expect(second).toEqual(first);
    });

    it('round-trip through parse preserves both v1 and v2 fields', () => {
      const first = serializePostContent(baseFrontmatter, 'T', 'B', { platform: 'ghost' });
      const parsed = parsePostContent(first);
      expect(parsed.frontmatter.ghost_id).toBe('abc');
      expect(parsed.frontmatter.ghost_slug).toBe('s');
      expect(parsed.frontmatter.ghost_status).toBe('published');
      expect(parsed.frontmatter.ghost_updated_at).toBe('2026-05-24T12:00:00.000Z');
      expect(parsed.frontmatter.tags).toEqual(['x']);
    });

    it('cms block precedes ghost_* keys in the YAML output', () => {
      // The order signals canonical-vs-legacy at a glance and supports the
      // eventual v1 deletion in v0.6.0 (search-and-delete `ghost_*` lines).
      const out = serializePostContent(baseFrontmatter, 'T', 'B');
      const cmsIdx = out.indexOf('cms:');
      const ghostIdx = out.indexOf('ghost_id:');
      expect(cmsIdx).toBeGreaterThan(-1);
      expect(ghostIdx).toBeGreaterThan(-1);
      expect(cmsIdx).toBeLessThan(ghostIdx);
    });
  });
});
