/**
 * In-memory WordPress REST API stand-in for tests.
 *
 * Extends `WordPressApiClient` so it's accepted by `WordPressAdapter`'s
 * constructor (typed against the real class). Every public method the adapter
 * calls is overridden — `super.*` is never invoked, so the fake never makes
 * real HTTP requests.
 */

import {
  WordPressApiClient,
  WpCategory,
  WpPost,
  WpPostInput,
  WpTag,
  WpMedia,
  WpMediaUploadInput,
} from '../../src/wordpress/api.js';
import { CmsApiError } from '../../src/cms/types.js';

export class FakeWordPressApi extends WordPressApiClient {
  posts = new Map<number, WpPost>();
  pages = new Map<number, WpPost>();
  tags: WpTag[] = [];
  categories: WpCategory[] = [];
  media = new Map<number, WpMedia>();
  uploadMediaCount = 0;

  private nextId = 1;

  /**
   * Monotonic clock for modified timestamps.
   * `new Date().toISOString()` can collide at sub-millisecond intervals in
   * fast tests, breaking optimistic-lock scenarios that depend on a strict
   * before/after ordering. Bumping a counter ensures every write produces a
   * strictly larger timestamp.
   */
  private clockMs = Date.now();
  private nextTimestamp(): string {
    this.clockMs += 1;
    return new Date(this.clockMs).toISOString();
  }

  constructor() {
    super('https://fake.example.com', 'admin', 'fake-app-password');
  }

  override async testConnection(): Promise<{ ok: boolean; message: string }> {
    return { ok: true, message: 'Connected as admin' };
  }

  override async fetchPosts(options?: {
    status?: string;
    page?: number;
    perPage?: number;
  }): Promise<WpPost[]> {
    const status = options?.status ?? 'any';
    const all = Array.from(this.posts.values());
    if (status === 'publish') return all.filter((p) => p.status === 'publish');
    if (status === 'draft') return all.filter((p) => p.status === 'draft');
    return all;
  }

  override async fetchPages(options?: {
    status?: string;
    page?: number;
    perPage?: number;
  }): Promise<WpPost[]> {
    const status = options?.status ?? 'any';
    const all = Array.from(this.pages.values());
    if (status === 'publish') return all.filter((p) => p.status === 'publish');
    if (status === 'draft') return all.filter((p) => p.status === 'draft');
    return all;
  }

  override async getPost(id: number): Promise<WpPost> {
    const post = this.posts.get(id);
    if (!post) {
      throw new CmsApiError(`Post ${id} not found`, 404, 'not_found', 'wordpress' as never);
    }
    return post;
  }

  override async getPage(id: number): Promise<WpPost> {
    const page = this.pages.get(id);
    if (!page) {
      throw new CmsApiError(`Page ${id} not found`, 404, 'not_found', 'wordpress' as never);
    }
    return page;
  }

  override async createPost(input: WpPostInput): Promise<WpPost> {
    const id = this.nextId++;
    const now = this.nextTimestamp();
    const status = (input.status ?? 'draft') as WpPost['status'];
    const post: WpPost = {
      id,
      slug: input.slug ?? `post-${id}`,
      title: { rendered: input.title ?? '' },
      content: { rendered: input.content ?? '' },
      excerpt: { rendered: input.excerpt ?? '' },
      status,
      tags: input.tags ?? [],
      categories: input.categories ?? [],
      featured_media: input.featured_media ?? 0,
      author: 1,
      date: now,
      date_gmt: now,
      modified: now,
      modified_gmt: now,
      link: status === 'publish' ? `https://fake.example.com/${input.slug ?? `post-${id}`}` : null,
    };
    this.posts.set(id, post);
    return post;
  }

  override async createPage(input: WpPostInput): Promise<WpPost> {
    const id = this.nextId++;
    const now = this.nextTimestamp();
    const status = (input.status ?? 'draft') as WpPost['status'];
    const page: WpPost = {
      id,
      slug: input.slug ?? `page-${id}`,
      title: { rendered: input.title ?? '' },
      content: { rendered: input.content ?? '' },
      excerpt: { rendered: input.excerpt ?? '' },
      status,
      tags: [],
      categories: [],
      featured_media: input.featured_media ?? 0,
      author: 1,
      date: now,
      date_gmt: now,
      modified: now,
      modified_gmt: now,
      link: status === 'publish' ? `https://fake.example.com/${input.slug ?? `page-${id}`}` : null,
    };
    this.pages.set(id, page);
    return page;
  }

  override async updatePost(id: number, input: WpPostInput): Promise<WpPost> {
    const existing = this.posts.get(id);
    if (!existing) {
      throw new CmsApiError(`Post ${id} not found`, 404, 'not_found', 'wordpress' as never);
    }
    const now = this.nextTimestamp();
    const status = (input.status !== undefined
      ? (input.status as WpPost['status'])
      : existing.status);
    const updated: WpPost = {
      ...existing,
      title: { rendered: input.title !== undefined ? input.title : existing.title.rendered },
      content: { rendered: input.content !== undefined ? input.content : existing.content.rendered },
      excerpt: { rendered: input.excerpt !== undefined ? input.excerpt : existing.excerpt.rendered },
      status,
      // Only overwrite taxonomy arrays when the input explicitly carries them.
      tags: input.tags !== undefined ? input.tags : existing.tags,
      categories: input.categories !== undefined ? input.categories : existing.categories,
      featured_media: input.featured_media !== undefined ? input.featured_media : existing.featured_media,
      modified: now,
      modified_gmt: now,
      link: status === 'publish'
        ? `https://fake.example.com/${input.slug ?? existing.slug}`
        : null,
    };
    this.posts.set(id, updated);
    return updated;
  }

  override async updatePage(id: number, input: WpPostInput): Promise<WpPost> {
    const existing = this.pages.get(id);
    if (!existing) {
      throw new CmsApiError(`Page ${id} not found`, 404, 'not_found', 'wordpress' as never);
    }
    const now = this.nextTimestamp();
    const status = (input.status !== undefined
      ? (input.status as WpPost['status'])
      : existing.status);
    const updated: WpPost = {
      ...existing,
      title: { rendered: input.title !== undefined ? input.title : existing.title.rendered },
      content: { rendered: input.content !== undefined ? input.content : existing.content.rendered },
      excerpt: { rendered: input.excerpt !== undefined ? input.excerpt : existing.excerpt.rendered },
      status,
      featured_media: input.featured_media !== undefined ? input.featured_media : existing.featured_media,
      modified: now,
      modified_gmt: now,
      link: status === 'publish'
        ? `https://fake.example.com/${input.slug ?? existing.slug}`
        : null,
    };
    this.pages.set(id, updated);
    return updated;
  }

  override async deletePost(id: number): Promise<void> {
    if (!this.posts.has(id)) {
      throw new CmsApiError(`Post ${id} not found`, 404, 'not_found', 'wordpress' as never);
    }
    this.posts.delete(id);
  }

  override async deletePage(id: number): Promise<void> {
    if (!this.pages.has(id)) {
      throw new CmsApiError(`Page ${id} not found`, 404, 'not_found', 'wordpress' as never);
    }
    this.pages.delete(id);
  }

  override async getMedia(id: number): Promise<WpMedia> {
    const m = this.media.get(id);
    if (!m) {
      throw new CmsApiError(`Media ${id} not found`, 404, 'not_found', 'wordpress' as never);
    }
    return m;
  }

  override async uploadMedia(input: WpMediaUploadInput): Promise<WpMedia> {
    this.uploadMediaCount++;
    const id = this.nextId++;
    const media: WpMedia = {
      id,
      source_url: `https://fake.example.com/wp-content/uploads/${encodeURIComponent(input.filename)}`,
    };
    this.media.set(id, media);
    return media;
  }

  override async listTags(): Promise<WpTag[]> {
    return [...this.tags];
  }

  override async listCategories(): Promise<WpCategory[]> {
    return [...this.categories];
  }

  override async createTag(name: string): Promise<WpTag> {
    const id = this.nextId++;
    const slug = name.toLowerCase().replace(/\s+/g, '-');
    const tag: WpTag = { id, slug, name };
    this.tags.push(tag);
    return tag;
  }

  override async createCategory(name: string): Promise<WpCategory> {
    const id = this.nextId++;
    const slug = name.toLowerCase().replace(/\s+/g, '-');
    const cat: WpCategory = { id, slug, name };
    this.categories.push(cat);
    return cat;
  }
}
