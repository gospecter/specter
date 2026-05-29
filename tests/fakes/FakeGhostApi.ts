/**
 * In-memory Ghost API stand-in for tests.
 *
 * Extends `GhostApiClient` so it can be wrapped by `GhostAdapter` to satisfy
 * `SyncEngine`'s `CmsAdapter` constructor argument. Use `.adapter()` to get
 * an adapter instance: `new SyncEngine(vault, fake.adapter(), settings)`.
 * Every method the adapter calls is overridden — `super.*` is never invoked,
 * so the fake never makes real HTTP calls or signs JWTs.
 */

import {
  GhostApiClient,
  GhostImage,
  GhostImageUploadInput,
  markdownToLexical,
} from '../../src/ghost/api.js';
import { GhostAdapter } from '../../src/ghost/adapter.js';
import {
  CreatePostData,
  GhostApiError,
  GhostPost,
  GhostPostsResponse,
  UpdatePostData,
} from '../../src/types.js';

let idCounter = 0;
let slugCounter = 0;

export function makeGhostPost(overrides: Partial<GhostPost> = {}): GhostPost {
  const id = overrides.id ?? `post-${++idCounter}`;
  const slug = overrides.slug ?? `post-${++slugCounter}`;
  const now = new Date().toISOString();
  return {
    id,
    uuid: id,
    title: overrides.title ?? 'Untitled',
    slug,
    html: overrides.html ?? null,
    mobiledoc: overrides.mobiledoc ?? null,
    lexical: overrides.lexical ?? markdownToLexical(''),
    status: overrides.status ?? 'published',
    visibility: overrides.visibility ?? 'public',
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
    published_at: overrides.published_at ?? null,
    custom_excerpt: overrides.custom_excerpt ?? null,
    feature_image: overrides.feature_image ?? null,
    featured: overrides.featured ?? false,
    tags: overrides.tags ?? [],
    authors: overrides.authors ?? [],
    url: overrides.url ?? '',
  };
}

export class FakeGhostApi extends GhostApiClient {
  private posts = new Map<string, GhostPost>();
  private pages = new Map<string, GhostPost>();

  /** Number of mutating calls — tests use this to assert that dry-run
   *  doesn't actually hit the API. */
  public createCount = 0;
  public updateCount = 0;
  public deleteCount = 0;
  public uploadImageCount = 0;

  /** Monotonic timestamp clock. Real Ghost guarantees every mutation
   *  advances `updated_at`, but `new Date().toISOString()` collides at
   *  sub-millisecond intervals in fast tests, defeating optimistic-lock
   *  scenarios. Bump deterministically instead. */
  private clockMs = Date.now();
  private nextTimestamp(): string {
    this.clockMs += 1;
    return new Date(this.clockMs).toISOString();
  }

  constructor() {
    // The real constructor stores url + key. We pass dummies; nothing in the
    // overridden methods reads them.
    super('http://fake.invalid', 'fakeid:fakehex');
  }

  /** Seed initial posts. */
  seed(posts: GhostPost[]): this {
    for (const p of posts) this.posts.set(p.id, p);
    return this;
  }

  snapshot(): GhostPost[] {
    return [...this.posts.values()];
  }

  snapshotPages(): GhostPost[] {
    return [...this.pages.values()];
  }

  /** Wrap this fake in a GhostAdapter so it satisfies CmsAdapter. */
  adapter(): GhostAdapter {
    return new GhostAdapter(this);
  }

  override async listPosts(): Promise<GhostPostsResponse> {
    const posts = [...this.posts.values()];
    return {
      posts,
      meta: {
        pagination: {
          page: 1,
          limit: 100,
          pages: 1,
          total: posts.length,
          next: null,
          prev: null,
        },
      },
    };
  }

  override async listPages(): Promise<GhostPostsResponse> {
    const pages = [...this.pages.values()];
    return {
      posts: pages,
      meta: {
        pagination: {
          page: 1,
          limit: 100,
          pages: 1,
          total: pages.length,
          next: null,
          prev: null,
        },
      },
    };
  }

  override async fetchAllPosts(options?: {
    includeDrafts?: boolean;
    includePublished?: boolean;
  }): Promise<GhostPost[]> {
    const includeDrafts = options?.includeDrafts ?? true;
    const includePublished = options?.includePublished ?? true;
    return [...this.posts.values()].filter((p) => {
      if (p.status === 'draft') return includeDrafts;
      if (p.status === 'published') return includePublished;
      return true;
    });
  }

  override async fetchAllPages(options?: {
    includeDrafts?: boolean;
    includePublished?: boolean;
  }): Promise<GhostPost[]> {
    const includeDrafts = options?.includeDrafts ?? true;
    const includePublished = options?.includePublished ?? true;
    return [...this.pages.values()].filter((p) => {
      if (p.status === 'draft') return includeDrafts;
      if (p.status === 'published') return includePublished;
      return true;
    });
  }

  override async getPost(id: string): Promise<GhostPost> {
    const p = this.posts.get(id);
    if (!p) throw new GhostApiError('Post not found', 404);
    return p;
  }

  override async getPage(id: string): Promise<GhostPost> {
    const p = this.pages.get(id);
    if (!p) throw new GhostApiError('Page not found', 404);
    return p;
  }

  override async getPostBySlug(slug: string): Promise<GhostPost> {
    for (const p of this.posts.values()) if (p.slug === slug) return p;
    throw new GhostApiError('Post not found', 404);
  }

  override async createPost(data: CreatePostData): Promise<GhostPost> {
    this.createCount++;
    const now = this.nextTimestamp();
    const post = makeGhostPost({
      title: data.title,
      status: data.status ?? 'draft',
      feature_image: data.feature_image ?? null,
      custom_excerpt: data.custom_excerpt ?? null,
      lexical: data.lexical ?? null,
      mobiledoc: data.mobiledoc ?? null,
      // Tags arrive as `{ name }[]` from the adapter; rehydrate to GhostTag.
      tags: data.tags?.map((t) => ({
        id: `tag-${t.name}`,
        name: t.name,
        slug: t.name.toLowerCase().replace(/\s+/g, '-'),
        description: null,
      })),
      created_at: now,
      updated_at: now,
    });
    this.posts.set(post.id, post);
    return post;
  }

  override async createPage(data: CreatePostData): Promise<GhostPost> {
    this.createCount++;
    const now = this.nextTimestamp();
    const page = makeGhostPost({
      title: data.title,
      status: data.status ?? 'draft',
      feature_image: data.feature_image ?? null,
      custom_excerpt: data.custom_excerpt ?? null,
      lexical: data.lexical ?? null,
      mobiledoc: data.mobiledoc ?? null,
      tags: data.tags?.map((t) => ({
        id: `tag-${t.name}`,
        name: t.name,
        slug: t.name.toLowerCase().replace(/\s+/g, '-'),
        description: null,
      })),
      created_at: now,
      updated_at: now,
    });
    this.pages.set(page.id, page);
    return page;
  }

  override async updatePost(data: UpdatePostData): Promise<GhostPost> {
    this.updateCount++;
    const current = this.posts.get(data.id);
    if (!current) throw new GhostApiError('Post not found', 404);

    // Optimistic locking: simulate Ghost's UPDATE_COLLISION if the caller's
    // updated_at doesn't match.
    if (data.updated_at && data.updated_at !== current.updated_at) {
      throw new GhostApiError(
        'Saving failed! Someone else is editing this post. UPDATE_COLLISION',
        422,
        'UPDATE_COLLISION',
      );
    }

    const next: GhostPost = {
      ...current,
      title: data.title ?? current.title,
      status: data.status ?? current.status,
      lexical: data.lexical ?? current.lexical,
      mobiledoc: data.mobiledoc ?? current.mobiledoc,
      html: data.html ?? current.html,
      feature_image: data.feature_image ?? current.feature_image,
      custom_excerpt: data.custom_excerpt ?? current.custom_excerpt,
      featured: data.featured ?? current.featured,
      // Preserve tags unless the caller explicitly supplied them.
      tags: data.tags
        ? data.tags.map((t) => ({
            id: `tag-${t.name}`,
            name: t.name,
            slug: t.name.toLowerCase().replace(/\s+/g, '-'),
            description: null,
          }))
        : current.tags,
      updated_at: this.nextTimestamp(),
    };
    this.posts.set(next.id, next);
    return next;
  }

  override async updatePage(data: UpdatePostData): Promise<GhostPost> {
    this.updateCount++;
    const current = this.pages.get(data.id);
    if (!current) throw new GhostApiError('Page not found', 404);

    if (data.updated_at && data.updated_at !== current.updated_at) {
      throw new GhostApiError(
        'Saving failed! Someone else is editing this page. UPDATE_COLLISION',
        422,
        'UPDATE_COLLISION',
      );
    }

    const next: GhostPost = {
      ...current,
      title: data.title ?? current.title,
      status: data.status ?? current.status,
      lexical: data.lexical ?? current.lexical,
      mobiledoc: data.mobiledoc ?? current.mobiledoc,
      html: data.html ?? current.html,
      feature_image: data.feature_image ?? current.feature_image,
      custom_excerpt: data.custom_excerpt ?? current.custom_excerpt,
      featured: data.featured ?? current.featured,
      tags: data.tags
        ? data.tags.map((t) => ({
            id: `tag-${t.name}`,
            name: t.name,
            slug: t.name.toLowerCase().replace(/\s+/g, '-'),
            description: null,
          }))
        : current.tags,
      updated_at: this.nextTimestamp(),
    };
    this.pages.set(next.id, next);
    return next;
  }

  override async deletePost(id: string): Promise<void> {
    this.deleteCount++;
    this.posts.delete(id);
  }

  override async deletePage(id: string): Promise<void> {
    this.deleteCount++;
    this.pages.delete(id);
  }

  override async uploadImage(input: GhostImageUploadInput): Promise<GhostImage> {
    this.uploadImageCount++;
    return {
      url: `https://fake.invalid/content/images/${encodeURIComponent(input.filename)}`,
      ref: input.ref ?? `image-${this.uploadImageCount}`,
    };
  }

  override async testConnection(): Promise<{ success: boolean; message: string }> {
    return { success: true, message: 'fake-ok' };
  }
}
