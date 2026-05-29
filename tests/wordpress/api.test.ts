import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WordPressApiClient, type WpPost } from '../../src/wordpress/api.js';
import { CmsApiError } from '../../src/cms/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePost(overrides: Partial<WpPost> = {}): WpPost {
  return {
    id: 1,
    slug: 'test-post',
    title: { rendered: 'Test Post' },
    content: { rendered: '<p>Hello</p>' },
    excerpt: { rendered: '<p>Short</p>' },
    status: 'publish',
    tags: [],
    categories: [],
    featured_media: 0,
    author: 1,
    date: '2026-01-01T00:00:00',
    date_gmt: '2026-01-01T00:00:00',
    modified: '2026-01-02T00:00:00',
    modified_gmt: '2026-01-02T00:00:00',
    link: 'https://example.com/test-post',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function htmlResponse(status = 403): Response {
  return new Response('<!DOCTYPE html><html><body>Forbidden</body></html>', {
    status,
    headers: { 'Content-Type': 'text/html' },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WordPressApiClient', () => {
  let client: WordPressApiClient;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = new WordPressApiClient('https://example.com', 'admin', 'xxxx yyyy zzzz aaaa bbbb cccc');
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Auth header encoding
  // -------------------------------------------------------------------------

  describe('auth header', () => {
    it('sends Basic auth with spaces stripped from appPassword', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ name: 'admin' }));

      await client.testConnection();

      const req = fetchSpy.mock.calls[0][1] as RequestInit;
      const authHeader = (req.headers as Record<string, string>)['Authorization'];

      // "admin:xxxxxxxxyyyyzzzzaaaabbbbcccc" base64-encoded
      const expected = `Basic ${btoa('admin:xxxxyyyyyzzzzaaaabbbbcccc'.replace(/y/g, 'y'))}`;
      // More precisely: spaces stripped → 'xxxxyyyy zzzz aaaa bbbb cccc'.replace(/\s/g,'')
      const stripped = 'xxxx yyyy zzzz aaaa bbbb cccc'.replace(/\s+/g, '');
      const expectedHeader = `Basic ${btoa(`admin:${stripped}`)}`;

      expect(authHeader).toBe(expectedHeader);
    });

    it('strips spaces from appPassword before base64 encoding', () => {
      const spaced = new WordPressApiClient('https://example.com', 'user', 'ab cd ef gh ij kl');
      const noSpace = new WordPressApiClient('https://example.com', 'user', 'abcdefghijkl');

      // Both clients should produce identical auth headers.
      // Access private field via cast to verify.
      const spacedAuth = (spaced as unknown as { authHeader: string }).authHeader;
      const noSpaceAuth = (noSpace as unknown as { authHeader: string }).authHeader;
      expect(spacedAuth).toBe(noSpaceAuth);
    });
  });

  // -------------------------------------------------------------------------
  // URL normalization
  // -------------------------------------------------------------------------

  describe('base URL normalization', () => {
    it('accepts bare site URL', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(makePost()));
      const c = new WordPressApiClient('https://example.com', 'u', 'p');
      await c.getPost(1);
      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toBe('https://example.com/wp-json/wp/v2/posts/1');
    });

    it('accepts URL with trailing slash', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(makePost()));
      const c = new WordPressApiClient('https://example.com/', 'u', 'p');
      await c.getPost(1);
      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toBe('https://example.com/wp-json/wp/v2/posts/1');
    });

    it('accepts URL already containing /wp-json', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(makePost()));
      const c = new WordPressApiClient('https://example.com/wp-json', 'u', 'p');
      await c.getPost(1);
      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toBe('https://example.com/wp-json/wp/v2/posts/1');
    });

    it('accepts URL already containing /wp-json/wp/v2', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(makePost()));
      const c = new WordPressApiClient('https://example.com/wp-json/wp/v2', 'u', 'p');
      await c.getPost(1);
      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toBe('https://example.com/wp-json/wp/v2/posts/1');
    });
  });

  // -------------------------------------------------------------------------
  // Error translation
  // -------------------------------------------------------------------------

  describe('error translation', () => {
    it('401 → CmsApiError with isAuthError() === true', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Sorry, you are not allowed.' }), { status: 401 }),
      );

      await expect(client.getPost(1)).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(CmsApiError);
        expect((err as CmsApiError).isAuthError()).toBe(true);
        return true;
      });
    });

    it('403 → CmsApiError with isAuthError() === true', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Forbidden' }), { status: 403 }),
      );

      await expect(client.getPost(1)).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(CmsApiError);
        expect((err as CmsApiError).isAuthError()).toBe(true);
        return true;
      });
    });

    it('404 → CmsApiError with isNotFound() === true', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Post not found.', code: 'rest_post_invalid_id' }), { status: 404 }),
      );

      await expect(client.getPost(999)).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(CmsApiError);
        expect((err as CmsApiError).isNotFound()).toBe(true);
        return true;
      });
    });

    it('429 with Retry-After: 60 → isRateLimited() === true and retryAfterMs === 60000', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Too many requests' }), {
          status: 429,
          headers: { 'Retry-After': '60' },
        }),
      );

      await expect(client.getPost(1)).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(CmsApiError);
        const apiErr = err as CmsApiError;
        expect(apiErr.isRateLimited()).toBe(true);
        expect(apiErr.retryAfterMs).toBe(60000);
        return true;
      });
    });

    it('409 → CmsApiError with isConflict() === true', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Invalid post ID.', code: 'rest_post_invalid_id' }), { status: 409 }),
      );

      await expect(client.updatePost(1, { title: 'x' })).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(CmsApiError);
        expect((err as CmsApiError).isConflict()).toBe(true);
        return true;
      });
    });

    it('HTML response body → CmsApiError with message mentioning security plugins', async () => {
      fetchSpy.mockResolvedValueOnce(htmlResponse(403));

      await expect(client.getPost(1)).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(CmsApiError);
        const msg = (err as CmsApiError).message;
        expect(msg).toMatch(/security plugin/i);
        expect(msg).toMatch(/Wordfence/);
        return true;
      });
    });

    it('HTML response body starting with lowercase <!doctype → also detected', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('<!doctype html><html><body>Error</body></html>', { status: 503 }),
      );

      await expect(client.getPost(1)).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(CmsApiError);
        expect((err as CmsApiError).message).toMatch(/security plugin/i);
        return true;
      });
    });

    it('non-2xx fallthrough → CmsApiError without specific errorType', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Internal error' }), { status: 500 }),
      );

      await expect(client.getPost(1)).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(CmsApiError);
        const apiErr = err as CmsApiError;
        expect(apiErr.statusCode).toBe(500);
        expect(apiErr.errorType).toBeUndefined();
        return true;
      });
    });
  });

  // -------------------------------------------------------------------------
  // fetchPosts pagination
  // -------------------------------------------------------------------------

  describe('fetchPosts pagination', () => {
    it('auto-paginates when X-WP-TotalPages: 3', async () => {
      const page1 = [makePost({ id: 1 }), makePost({ id: 2 })];
      const page2 = [makePost({ id: 3 }), makePost({ id: 4 })];
      const page3 = [makePost({ id: 5 })];

      fetchSpy
        .mockResolvedValueOnce(jsonResponse(page1, 200, { 'X-WP-TotalPages': '3' }))
        .mockResolvedValueOnce(jsonResponse(page2, 200, { 'X-WP-TotalPages': '3' }))
        .mockResolvedValueOnce(jsonResponse(page3, 200, { 'X-WP-TotalPages': '3' }));

      const posts = await client.fetchPosts();

      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(posts).toHaveLength(5);
      expect(posts.map((p) => p.id)).toEqual([1, 2, 3, 4, 5]);
    });

    it('returns single page when X-WP-TotalPages: 1', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse([makePost({ id: 1 })], 200, { 'X-WP-TotalPages': '1' }));

      const posts = await client.fetchPosts();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(posts).toHaveLength(1);
    });

    it('returns single page when caller specifies page number', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse([makePost({ id: 3 })], 200, { 'X-WP-TotalPages': '5' }));

      const posts = await client.fetchPosts({ page: 2 });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(posts).toHaveLength(1);
    });

    it('passes status param to each paginated request', async () => {
      fetchSpy
        .mockResolvedValueOnce(jsonResponse([makePost()], 200, { 'X-WP-TotalPages': '2' }))
        .mockResolvedValueOnce(jsonResponse([makePost({ id: 2 })], 200, { 'X-WP-TotalPages': '2' }));

      await client.fetchPosts({ status: 'draft' });

      for (const call of fetchSpy.mock.calls) {
        expect(String(call[0])).toContain('status=draft');
      }
    });

    it('missing X-WP-TotalPages header → treats as single page', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse([makePost()], 200));

      const posts = await client.fetchPosts();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(posts).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // CRUD methods — smoke tests
  // -------------------------------------------------------------------------

  describe('getPost', () => {
    it('fetches a post by ID', async () => {
      const post = makePost({ id: 42, slug: 'hello' });
      fetchSpy.mockResolvedValueOnce(jsonResponse(post));

      const result = await client.getPost(42);

      expect(result.id).toBe(42);
      expect(result.slug).toBe('hello');
      expect(String(fetchSpy.mock.calls[0][0])).toContain('/posts/42');
    });
  });

  describe('createPost', () => {
    it('POSTs to /posts and returns new post', async () => {
      const created = makePost({ id: 10, slug: 'new-post' });
      fetchSpy.mockResolvedValueOnce(jsonResponse(created));

      const result = await client.createPost({ title: 'New Post', status: 'draft' });

      expect(result.id).toBe(10);
      const call = fetchSpy.mock.calls[0];
      expect((call[1] as RequestInit).method).toBe('POST');
      expect(String(call[0])).toMatch(/\/posts$/);
    });
  });

  describe('updatePost', () => {
    it('POSTs to /posts/{id} and returns updated post', async () => {
      const updated = makePost({ id: 5, slug: 'updated' });
      fetchSpy.mockResolvedValueOnce(jsonResponse(updated));

      const result = await client.updatePost(5, { title: 'Updated' });

      expect(result.id).toBe(5);
      const call = fetchSpy.mock.calls[0];
      expect((call[1] as RequestInit).method).toBe('POST');
      expect(String(call[0])).toContain('/posts/5');
    });
  });

  describe('deletePost', () => {
    it('sends DELETE with force=true', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));

      await client.deletePost(7);

      const call = fetchSpy.mock.calls[0];
      expect((call[1] as RequestInit).method).toBe('DELETE');
      expect(String(call[0])).toContain('force=true');
    });
  });

  describe('getMedia', () => {
    it('fetches media by ID and returns source_url', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ source_url: 'https://example.com/img.jpg' }));

      const media = await client.getMedia(99);

      expect(media.source_url).toBe('https://example.com/img.jpg');
    });
  });

  describe('listCategories', () => {
    it('returns all categories including paginated ones', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          jsonResponse([{ id: 1, slug: 'news', name: 'News' }], 200, { 'X-WP-TotalPages': '2' }),
        )
        .mockResolvedValueOnce(
          jsonResponse([{ id: 2, slug: 'tech', name: 'Tech' }], 200, { 'X-WP-TotalPages': '2' }),
        );

      const cats = await client.listCategories();

      expect(cats).toHaveLength(2);
      expect(cats[0].slug).toBe('news');
      expect(cats[1].slug).toBe('tech');
    });
  });

  // -------------------------------------------------------------------------
  // testConnection
  // -------------------------------------------------------------------------

  describe('testConnection', () => {
    it('returns ok:true on success', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ name: 'Admin User' }));

      const result = await client.testConnection();

      expect(result.ok).toBe(true);
      expect(result.message).toContain('Admin User');
      expect(fetchSpy.mock.calls[0][0]).toBe('https://example.com/wp-json/wp/v2/users/me');
    });

    it('returns ok:false on 401', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

      const result = await client.testConnection();

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/authentication failed/i);
    });

    it('returns ok:false on 404 with permalink hint', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

      const result = await client.testConnection();

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/pretty permalinks/i);
    });
  });

  describe('pages and media', () => {
    it('fetches pages from /pages', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse([makePost({ id: 7, slug: 'about' })]));

      const pages = await client.fetchPages();

      expect(pages[0].slug).toBe('about');
      expect(String(fetchSpy.mock.calls[0][0])).toContain('/pages?');
    });

    it('uploads media as raw body with content-disposition', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        id: 44,
        source_url: 'https://example.com/wp-content/uploads/hero.jpg',
      }, 201));

      const media = await client.uploadMedia({
        file: new Blob(['fake image'], { type: 'image/jpeg' }),
        filename: 'hero.jpg',
        mimeType: 'image/jpeg',
      });

      expect(media.id).toBe(44);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://example.com/wp-json/wp/v2/media');
      expect(init.method).toBe('POST');
      const headers = init.headers as Record<string, string>;
      expect(headers['Content-Disposition']).toBe('attachment; filename="hero.jpg"');
      expect(headers['Content-Type']).toBe('image/jpeg');
    });
  });
});
