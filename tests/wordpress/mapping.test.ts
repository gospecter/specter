import { describe, it, expect } from 'vitest';
import type { WpPost } from '../../src/wordpress/api.js';
import {
  wpPostToRemotePost,
  markdownToWpHtml,
  remotePostToWpInput,
} from '../../src/wordpress/mapping.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeWpPost(overrides: Partial<WpPost> = {}): WpPost {
  return {
    id: 42,
    slug: 'my-first-post',
    title: { rendered: 'My First Post' },
    content: { rendered: '<p><strong>bold</strong> and <code>code</code></p>' },
    excerpt: { rendered: '<p>A short summary.</p>' },
    status: 'publish',
    tags: [10, 20],
    categories: [5],
    featured_media: 0,
    author: 1,
    date: '2026-05-01T10:00:00',
    date_gmt: '2026-05-01T10:00:00.000Z',
    modified: '2026-05-01T10:05:00',
    modified_gmt: '2026-05-01T10:05:00.000Z',
    link: 'https://example.com/my-first-post',
    ...overrides,
  };
}

const TAG_NAMES: Map<number, string> = new Map([
  [10, 'tutorial'],
  [20, 'javascript'],
]);

const CAT_NAMES: Map<number, string> = new Map([
  [5, 'news'],
]);

// ---------------------------------------------------------------------------
// wpPostToRemotePost
// ---------------------------------------------------------------------------

describe('wpPostToRemotePost', () => {
  it('converts body HTML to markdown with bold and code tokens', () => {
    const remote = wpPostToRemotePost(makeWpPost(), TAG_NAMES, CAT_NAMES, null);
    expect(remote.body).toContain('**bold**');
    expect(remote.body).toContain('`code`');
  });

  it('maps id to string', () => {
    const remote = wpPostToRemotePost(makeWpPost(), TAG_NAMES, CAT_NAMES, null);
    expect(remote.id).toBe('42');
  });

  it('sets slug and uses modified_gmt as updatedAt', () => {
    const remote = wpPostToRemotePost(makeWpPost(), TAG_NAMES, CAT_NAMES, null);
    expect(remote.slug).toBe('my-first-post');
    expect(remote.updatedAt).toBe('2026-05-01T10:05:00.000Z');
  });

  it('uses date_gmt as createdAt', () => {
    const remote = wpPostToRemotePost(makeWpPost(), TAG_NAMES, CAT_NAMES, null);
    expect(remote.createdAt).toBe('2026-05-01T10:00:00.000Z');
  });

  // Status mapping

  it("maps WP 'publish' → RemotePost 'published'", () => {
    const remote = wpPostToRemotePost(makeWpPost({ status: 'publish' }), TAG_NAMES, CAT_NAMES, null);
    expect(remote.status).toBe('published');
  });

  it("maps WP 'draft' → RemotePost 'draft'", () => {
    const remote = wpPostToRemotePost(makeWpPost({ status: 'draft' }), TAG_NAMES, CAT_NAMES, null);
    expect(remote.status).toBe('draft');
  });

  it("maps WP 'future' → RemotePost 'scheduled'", () => {
    const remote = wpPostToRemotePost(makeWpPost({ status: 'future' }), TAG_NAMES, CAT_NAMES, null);
    expect(remote.status).toBe('scheduled');
  });

  it("maps WP 'private' → RemotePost 'draft'", () => {
    const remote = wpPostToRemotePost(makeWpPost({ status: 'private' }), TAG_NAMES, CAT_NAMES, null);
    expect(remote.status).toBe('draft');
  });

  it("maps WP 'pending' → RemotePost 'draft'", () => {
    const remote = wpPostToRemotePost(makeWpPost({ status: 'pending' }), TAG_NAMES, CAT_NAMES, null);
    expect(remote.status).toBe('draft');
  });

  // Category / tag split

  it('merges tags and categories — categories prefixed cat:', () => {
    const remote = wpPostToRemotePost(makeWpPost(), TAG_NAMES, CAT_NAMES, null);
    expect(remote.tags).toContain('tutorial');
    expect(remote.tags).toContain('javascript');
    expect(remote.tags).toContain('cat:news');
  });

  it('produces correct tags when post has one category and one tag', () => {
    const post = makeWpPost({ tags: [10], categories: [5] });
    const catNames: Map<number, string> = new Map([[5, 'news']]);
    const tagNames: Map<number, string> = new Map([[10, 'tutorial']]);
    const remote = wpPostToRemotePost(post, tagNames, catNames, null);
    expect(remote.tags).toEqual(['tutorial', 'cat:news']);
  });

  // Summary

  it('strips HTML from excerpt and uses it as summary', () => {
    const remote = wpPostToRemotePost(makeWpPost(), TAG_NAMES, CAT_NAMES, null);
    expect(remote.summary).toBe('A short summary.');
  });

  it('sets summary to null when excerpt is empty', () => {
    const remote = wpPostToRemotePost(
      makeWpPost({ excerpt: { rendered: '' } }),
      TAG_NAMES, CAT_NAMES, null,
    );
    expect(remote.summary).toBeNull();
  });

  // Feature image

  it('sets featureImage from mediaUrl param', () => {
    const remote = wpPostToRemotePost(makeWpPost(), TAG_NAMES, CAT_NAMES, 'https://example.com/img.jpg');
    expect(remote.featureImage).toBe('https://example.com/img.jpg');
  });

  it('sets featureImage to null when mediaUrl is null', () => {
    const remote = wpPostToRemotePost(makeWpPost(), TAG_NAMES, CAT_NAMES, null);
    expect(remote.featureImage).toBeNull();
  });

  // Author

  it('sets author to null (deferred to v2)', () => {
    const remote = wpPostToRemotePost(makeWpPost(), TAG_NAMES, CAT_NAMES, null);
    expect(remote.author).toBeNull();
  });

  // Container

  it('sets container to null (flat platform)', () => {
    const remote = wpPostToRemotePost(makeWpPost(), TAG_NAMES, CAT_NAMES, null);
    expect(remote.container).toBeNull();
  });

  // URL

  it('sets url to post.link when published', () => {
    const remote = wpPostToRemotePost(makeWpPost({ status: 'publish' }), TAG_NAMES, CAT_NAMES, null);
    expect(remote.url).toBe('https://example.com/my-first-post');
  });

  it('sets url to null when not published', () => {
    const remote = wpPostToRemotePost(makeWpPost({ status: 'draft' }), TAG_NAMES, CAT_NAMES, null);
    expect(remote.url).toBeNull();
  });

  // HTML entity decoding

  it('decodes &amp; in title', () => {
    const remote = wpPostToRemotePost(
      makeWpPost({ title: { rendered: 'Foo &amp; Bar' } }),
      TAG_NAMES, CAT_NAMES, null,
    );
    expect(remote.title).toBe('Foo & Bar');
  });

  it('decodes &#8217; (right single quotation mark) in title', () => {
    const remote = wpPostToRemotePost(
      makeWpPost({ title: { rendered: "It&#8217;s a post" } }),
      TAG_NAMES, CAT_NAMES, null,
    );
    expect(remote.title).toBe("It’s a post");
  });
});

// ---------------------------------------------------------------------------
// markdownToWpHtml
// ---------------------------------------------------------------------------

describe('markdownToWpHtml', () => {
  it('converts bold markdown to <strong>', () => {
    const html = markdownToWpHtml('**bold text**');
    expect(html).toContain('<strong>bold text</strong>');
  });

  it('converts inline code to <code>', () => {
    const html = markdownToWpHtml('`code`');
    expect(html).toContain('<code>code</code>');
  });

  it('strips <script> tags when trustVaultContent is false', () => {
    const html = markdownToWpHtml('<script>alert("x")</script>\n\nHello', { trustVaultContent: false });
    expect(html).not.toContain('<script>');
    expect(html).toContain('Hello');
  });

  it('strips <script> tags by default (trustVaultContent defaults to false)', () => {
    const html = markdownToWpHtml('<script>alert("x")</script>\n\nHello');
    expect(html).not.toContain('<script>');
  });

  it('passes <script> through when trustVaultContent is true', () => {
    const html = markdownToWpHtml('<script>alert("x")</script>', { trustVaultContent: true });
    expect(html).toContain('<script>alert("x")</script>');
  });

  it('strips <iframe> when trustVaultContent is false', () => {
    const html = markdownToWpHtml('<iframe src="https://evil.com"></iframe>', { trustVaultContent: false });
    expect(html).not.toContain('<iframe>');
  });
});

// ---------------------------------------------------------------------------
// remotePostToWpInput — status round-trip
// ---------------------------------------------------------------------------

describe('remotePostToWpInput', () => {
  it("maps status 'published' → WP 'publish'", () => {
    const input = remotePostToWpInput(
      { title: 'Test', body: 'Hello', status: 'published' },
      [], [],
    );
    expect(input.status).toBe('publish');
  });

  it("maps status 'scheduled' → WP 'future'", () => {
    const input = remotePostToWpInput(
      { title: 'Test', body: 'Hello', status: 'scheduled' },
      [], [],
    );
    expect(input.status).toBe('future');
  });

  it("maps status 'draft' → WP 'draft'", () => {
    const input = remotePostToWpInput(
      { title: 'Test', body: 'Hello', status: 'draft' },
      [], [],
    );
    expect(input.status).toBe('draft');
  });

  it('converts body markdown to HTML', () => {
    const input = remotePostToWpInput(
      { title: 'Test', body: '**bold**' },
      [], [],
    );
    expect(input.content).toContain('<strong>bold</strong>');
  });

  it('passes categoryIds and tagIds through', () => {
    const input = remotePostToWpInput(
      { title: 'Test', body: 'Hello' },
      [1, 2], [10, 20],
    );
    expect(input.categories).toEqual([1, 2]);
    expect(input.tags).toEqual([10, 20]);
  });

  it('sets excerpt from summary', () => {
    const input = remotePostToWpInput(
      { title: 'Test', body: 'Hello', summary: 'Short summary' },
      [], [],
    );
    expect(input.excerpt).toBe('Short summary');
  });

  it('sets slug when provided', () => {
    const input = remotePostToWpInput(
      { title: 'Test', body: 'Hello', slug: 'my-slug' },
      [], [],
    );
    expect(input.slug).toBe('my-slug');
  });

  // Status round-trip: WP publish → RemotePost published → WP publish
  it('status round-trip: WP publish → RemotePost published → WP publish', () => {
    const wpPost = makeWpPost({ status: 'publish' });
    const remote = wpPostToRemotePost(wpPost, new Map(), new Map(), null);
    expect(remote.status).toBe('published');

    const wpInput = remotePostToWpInput({ body: remote.body, status: remote.status }, [], []);
    expect(wpInput.status).toBe('publish');
  });
});
