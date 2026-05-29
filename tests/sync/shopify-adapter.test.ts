import { describe, expect, it, beforeEach } from 'vitest';
import { ShopifyAdapter } from '../../src/shopify/adapter.js';
import {
  createInputToShopify,
  markdownToHtml,
  shopifyArticleToRemotePost,
  updateInputToShopify,
} from '../../src/shopify/mapping.js';
import { CmsApiError } from '../../src/cms/types.js';
import { FakeShopifyApi, makeShopifyArticle, makeShopifyBlog } from '../fakes/FakeShopifyApi.js';

describe('Shopify mapping', () => {
  it('article → RemotePost preserves identity fields', () => {
    const article = makeShopifyArticle({
      id: 'gid://shopify/Article/42',
      title: 'Hello',
      handle: 'hello',
      body: '<p>Body <strong>here</strong>.</p>',
      summary: 'sum',
      author: { name: 'Axel' },
      tags: ['a', 'b'],
      isPublished: true,
      publishedAt: '2026-05-24T12:00:00Z',
      image: { url: 'https://cdn/x.jpg', altText: 'x' },
      blog: { id: 'gid://shopify/Blog/9', handle: 'news', title: 'News' },
    });
    const remote = shopifyArticleToRemotePost(article, 'specter-test.myshopify.com');
    expect(remote.id).toBe('gid://shopify/Article/42');
    expect(remote.slug).toBe('hello');
    expect(remote.status).toBe('published');
    expect(remote.tags).toEqual(['a', 'b']);
    expect(remote.author).toBe('Axel');
    expect(remote.featureImage).toBe('https://cdn/x.jpg');
    expect(remote.container).toEqual({
      id: 'gid://shopify/Blog/9',
      handle: 'news',
      title: 'News',
    });
    expect(remote.body).toContain('Body **here**');
    expect(remote.url).toContain('/blogs/news/hello');
  });

  it('unpublished article → status draft and url null', () => {
    const article = makeShopifyArticle({ isPublished: false });
    const remote = shopifyArticleToRemotePost(article, 'shop.myshopify.com');
    expect(remote.status).toBe('draft');
    expect(remote.url).toBeNull();
  });

  it('empty summary becomes null', () => {
    const article = makeShopifyArticle({ summary: '' });
    const remote = shopifyArticleToRemotePost(article);
    expect(remote.summary).toBeNull();
  });

  it('markdownToHtml sanitizes dangerous tags by default (XSS defense)', () => {
    const html = markdownToHtml(
      '# Hi\n\n<script>alert(1)</script><iframe src="x"></iframe><style>.x{}</style>',
    );
    expect(html).toContain('<h1>Hi</h1>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('<style');
  });

  it('markdownToHtml strips javascript: URLs and event handlers', () => {
    const html = markdownToHtml('<a href="javascript:alert(1)" onclick="bad()">x</a>');
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/onclick=/i);
  });

  it('markdownToHtml passes raw HTML through when trustVaultContent=true', () => {
    const html = markdownToHtml('<iframe src="x"></iframe>', { trustVaultContent: true });
    expect(html).toContain('<iframe');
  });

  it('markdownToHtml preserves safe inline markup', () => {
    const html = markdownToHtml('**bold** and `code` and [link](https://x.com).');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('href="https://x.com"');
  });

  it('createInputToShopify maps body markdown to HTML and sets isPublished', () => {
    const out = createInputToShopify(
      {
        title: 'T',
        slug: 't',
        body: '**bold**',
        status: 'published',
        tags: ['x'],
        summary: 's',
        author: 'A',
        featureImage: 'https://img/x.jpg',
      },
      'gid://shopify/Blog/1',
    );
    expect(out.blogId).toBe('gid://shopify/Blog/1');
    expect(out.title).toBe('T');
    expect(out.handle).toBe('t');
    expect(out.body).toContain('<strong>bold</strong>');
    expect(out.isPublished).toBe(true);
    expect(out.image).toEqual({ url: 'https://img/x.jpg' });
    expect(out.author).toEqual({ name: 'A' });
  });

  it('updateInputToShopify only includes provided fields', () => {
    const out = updateInputToShopify({ title: 'New' });
    expect(out.title).toBe('New');
    expect(out.body).toBeUndefined();
    expect(out.isPublished).toBeUndefined();
    expect(out.tags).toBeUndefined();
  });

  it('updateInputToShopify clears featureImage when set to null', () => {
    const out = updateInputToShopify({ featureImage: null });
    expect(out.image).toBeNull();
  });

  it('status="scheduled" maps to isPublished=true (Shopify lacks scheduled state)', () => {
    const create = createInputToShopify(
      { title: 'T', body: '', status: 'scheduled' },
      'gid://shopify/Blog/1',
    );
    expect(create.isPublished).toBe(true);
  });
});

describe('ShopifyAdapter', () => {
  let api: FakeShopifyApi;
  let adapter: ShopifyAdapter;

  beforeEach(() => {
    api = new FakeShopifyApi();
    api.seedDefaultBlog();
    adapter = new ShopifyAdapter(api, 'specter-test.myshopify.com');
  });

  it('platform is shopify', () => {
    expect(adapter.platform).toBe('shopify');
  });

  it('testConnection returns ok on success', async () => {
    const r = await adapter.testConnection();
    expect(r.ok).toBe(true);
  });

  it('listContainers returns the seeded blog', async () => {
    const containers = await adapter.listContainers();
    expect(containers).toHaveLength(1);
    expect(containers[0].handle).toBe('news');
  });

  it('createPost creates an article in the default blog and returns RemotePost', async () => {
    const remote = await adapter.createPost({
      title: 'New article',
      body: '# Hello\n\nWorld',
      slug: 'new-article',
      status: 'draft',
      tags: ['t1'],
    });
    expect(remote.slug).toBe('new-article');
    expect(remote.body).toContain('Hello');
    expect(remote.container?.handle).toBe('news');
    expect(api.createCount).toBe(1);
  });

  it('createPost respects explicit containerHandle', async () => {
    const blog2 = makeShopifyBlog({ handle: 'blog-2', title: 'Blog 2' });
    api.blogs.push(blog2);
    adapter.invalidateBlogCache();
    const remote = await adapter.createPost({
      title: 'X',
      body: '',
      containerHandle: 'blog-2',
    });
    expect(remote.container?.handle).toBe('blog-2');
  });

  it('createPost fails clearly when no blogs exist', async () => {
    api.blogs = [];
    adapter.invalidateBlogCache();
    await expect(adapter.createPost({ title: 'X', body: '' })).rejects.toThrow(/no blogs/i);
  });

  it('createPost fails when containerHandle unknown', async () => {
    await expect(
      adapter.createPost({ title: 'X', body: '', containerHandle: 'ghost' }),
    ).rejects.toThrow(/not found/i);
  });

  it('updatePost edits the existing article', async () => {
    const created = await adapter.createPost({ title: 'A', body: 'b' });
    const updated = await adapter.updatePost(created.id, {
      title: 'A renamed',
      body: '**new body**',
    });
    expect(updated.title).toBe('A renamed');
    expect(updated.body).toContain('**new body**');
    expect(api.updateCount).toBe(1);
  });

  it('updatePost can move article to a different container', async () => {
    const blog2 = makeShopifyBlog({ handle: 'blog-2', title: 'Blog 2' });
    api.blogs.push(blog2);
    adapter.invalidateBlogCache();
    const created = await adapter.createPost({ title: 'A', body: 'b' });
    const moved = await adapter.updatePost(created.id, { containerHandle: 'blog-2' });
    expect(moved.container?.handle).toBe('blog-2');
  });

  it('listPosts returns mapped RemotePosts', async () => {
    await adapter.createPost({ title: 'A', body: 'a' });
    await adapter.createPost({ title: 'B', body: 'b' });
    const all = await adapter.listPosts();
    expect(all).toHaveLength(2);
    expect(all[0].body).toBeDefined();
  });

  it('listPosts honors includeDrafts=false', async () => {
    await adapter.createPost({ title: 'Pub', body: 'a', status: 'published' });
    await adapter.createPost({ title: 'Drft', body: 'b', status: 'draft' });
    const onlyPublished = await adapter.listPosts({ includeDrafts: false, includePublished: true });
    expect(onlyPublished).toHaveLength(1);
    expect(onlyPublished[0].status).toBe('published');
  });

  it('deletePost removes the article', async () => {
    const created = await adapter.createPost({ title: 'A', body: 'b' });
    await adapter.deletePost(created.id);
    await expect(adapter.getPost(created.id)).rejects.toBeInstanceOf(CmsApiError);
    expect(api.deleteCount).toBe(1);
  });

  it('caches listBlogs across calls', async () => {
    await adapter.listContainers();
    await adapter.createPost({ title: 'A', body: 'b' });
    await adapter.createPost({ title: 'B', body: 'c' });
    expect(api.listBlogsCount).toBe(1);
  });

  it('invalidateBlogCache forces a refetch', async () => {
    await adapter.listContainers();
    adapter.invalidateBlogCache();
    await adapter.listContainers();
    expect(api.listBlogsCount).toBe(2);
  });

  it('concurrent createPost calls share a single listBlogs round-trip (in-flight dedup)', async () => {
    // Five concurrent createPosts before any have resolved should hit listBlogs once total.
    await Promise.all([
      adapter.createPost({ title: 'A', body: 'a' }),
      adapter.createPost({ title: 'B', body: 'b' }),
      adapter.createPost({ title: 'C', body: 'c' }),
      adapter.createPost({ title: 'D', body: 'd' }),
      adapter.createPost({ title: 'E', body: 'e' }),
    ]);
    expect(api.listBlogsCount).toBe(1);
  });

  it('retries once on blog_not_found (blog created out of band)', async () => {
    // Cache the current blog list (just "news")
    await adapter.listContainers();
    // Simulate a new blog created in the Shopify admin AFTER cache
    const newBlog = makeShopifyBlog({ handle: 'created-out-of-band', title: 'Out of Band' });
    api.blogs.push(newBlog);
    // First call would fail blog-not-found in stale cache; auto-retry should refetch and succeed
    const remote = await adapter.createPost({
      title: 'X',
      body: 'b',
      containerHandle: 'created-out-of-band',
    });
    expect(remote.container?.handle).toBe('created-out-of-band');
    // listBlogs called twice: initial seed + retry refetch
    expect(api.listBlogsCount).toBe(2);
  });
});

describe('CmsApiError helpers', () => {
  it('isConflict is set by explicit errorType', async () => {
    const { CmsApiError } = await import('../../src/cms/types.js');
    const e = new CmsApiError('UPDATE_COLLISION', 422, 'conflict', 'ghost');
    expect(e.isConflict()).toBe(true);
    const e2 = new CmsApiError('UPDATE_COLLISION', 422, 'graphql', 'ghost');
    expect(e2.isConflict()).toBe(false);
  });

  it('isRateLimited covers THROTTLED, 429, 430', async () => {
    const { CmsApiError } = await import('../../src/cms/types.js');
    expect(new CmsApiError('x', 200, 'rate_limited', 'shopify').isRateLimited()).toBe(true);
    expect(new CmsApiError('x', 429, 'http', 'shopify').isRateLimited()).toBe(true);
    expect(new CmsApiError('x', 430, 'http', 'shopify').isRateLimited()).toBe(true);
    expect(new CmsApiError('x', 500, 'graphql', 'shopify').isRateLimited()).toBe(false);
  });

  it('isAuthError covers 401 and 403', async () => {
    const { CmsApiError } = await import('../../src/cms/types.js');
    expect(new CmsApiError('x', 401, 'auth', 'shopify').isAuthError()).toBe(true);
    expect(new CmsApiError('x', 403, 'auth', 'shopify').isAuthError()).toBe(true);
    expect(new CmsApiError('x', 404, 'not_found', 'shopify').isAuthError()).toBe(false);
  });

  it('retryAfterMs propagates from rate-limit errors', async () => {
    const { CmsApiError } = await import('../../src/cms/types.js');
    const e = new CmsApiError('throttled', 200, 'rate_limited', 'shopify', 1500);
    expect(e.retryAfterMs).toBe(1500);
  });
});

describe('CmsAdapter factory', () => {
  it('createAdapter("shopify") returns a ShopifyAdapter', async () => {
    const { createAdapter } = await import('../../src/cms/index.js');
    const a = createAdapter({
      platform: 'shopify',
      shop: 'x.myshopify.com',
      accessToken: 'shpat_fake',
    });
    expect(a.platform).toBe('shopify');
  });

  it('createAdapter("ghost") returns a GhostAdapter', async () => {
    const { createAdapter } = await import('../../src/cms/index.js');
    const a = createAdapter({
      platform: 'ghost',
      ghostUrl: 'https://example.ghost.io',
      adminApiKey: 'id:secret',
    });
    expect(a.platform).toBe('ghost');
  });
});
