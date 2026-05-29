/**
 * WordPress implementation of CmsAdapter.
 *
 * Orchestrates WordPressApiClient + mapping layer. Manages tag/category caches
 * (lazy-populated, 5-minute TTL). Implements client-side optimistic locking via
 * modified_gmt comparison — WP REST has no native conditional-update primitive.
 *
 * Featured image push (v1): omitted. WP needs an integer media attachment ID to
 * set featured_media; reliably mapping a URL back to that ID without a media
 * upload primitive is not safe (Risk #4 in spec). featureImage is read-only in v1.
 */

import { CmsAdapter } from '../cms/adapter.js';
import {
  CmsApiError,
  ContentKind,
  CreateContentInput,
  CreatePostInput,
  ListOptions,
  Platform,
  RemoteContentItem,
  RemoteContainer,
  RemoteMediaRef,
  RemotePost,
  UpdateContentInput,
  UpdatePostInput,
  UploadMediaInput,
} from '../cms/types.js';
import { WordPressApiClient, WpCategory, WpTag, WpPostInput } from './api.js';
import {
  MarkdownToHtmlOptions,
  remotePostToWpInput,
  wpPostToRemotePost,
} from './mapping.js';

/** WP REST accepts a `date` field (ISO 8601 local time) when status='future'. */
interface WpPostInputWithDate extends WpPostInput {
  date?: string;
}

const WP_PLATFORM: Platform = 'wordpress';
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface WordPressAdapterOptions extends MarkdownToHtmlOptions {
  /** TTL for tag/category caches in ms. Default 5 minutes. */
  cacheTtlMs?: number;
}

interface TaxonomyCache {
  tags: WpTag[];
  categories: WpCategory[];
  fetchedAt: number;
}

export class WordPressAdapter implements CmsAdapter {
  readonly platform: Platform = WP_PLATFORM;

  readonly capabilities = {
    containers: 'flat' as const,
    optimisticLock: true,
  };

  private taxonomyCache: TaxonomyCache | null = null;
  private taxonomyPromise: Promise<TaxonomyCache> | null = null;
  private readonly mediaIdByUrl = new Map<string, number>();
  private readonly cacheTtlMs: number;
  private readonly htmlOptions: MarkdownToHtmlOptions;

  constructor(
    private api: WordPressApiClient,
    private siteUrl: string,
    options: WordPressAdapterOptions = {},
  ) {
    this.cacheTtlMs = options.cacheTtlMs ?? CACHE_TTL_MS;
    this.htmlOptions = { trustVaultContent: options.trustVaultContent };
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    return this.api.testConnection();
  }

  async listPosts(options?: ListOptions): Promise<RemotePost[]> {
    return this.translate(async () => {
      const includeDrafts = options?.includeDrafts !== false;
      const includePublished = options?.includePublished !== false;

      let status: string;
      if (includeDrafts && includePublished) {
        status = 'any';
      } else if (includeDrafts) {
        status = 'draft';
      } else {
        status = 'publish';
      }

      const [posts, { tagNames, categoryNames }] = await Promise.all([
        this.api.fetchPosts({ status }),
        this.getTaxonomyMaps(),
      ]);

      const mediaUrls = await this.resolveMediaBatch(posts.map((p) => p.featured_media));

      return posts.map((post, i) =>
        wpPostToRemotePost(post, tagNames, categoryNames, mediaUrls[i], 'post'),
      );
    });
  }

  async getPost(id: string): Promise<RemotePost> {
    return this.translate(async () => {
      const [post, { tagNames, categoryNames }] = await Promise.all([
        this.api.getPost(Number(id)),
        this.getTaxonomyMaps(),
      ]);
      const mediaUrl = post.featured_media !== 0
        ? (await this.api.getMedia(post.featured_media)).source_url
        : null;
      return wpPostToRemotePost(post, tagNames, categoryNames, mediaUrl, 'post');
    });
  }

  async createPost(input: CreatePostInput): Promise<RemotePost> {
    return this.translate(async () => {
      const { categoryIds, tagIds } = await this.resolveTagsAndCategories(input.tags ?? []);
      const wpInput: WpPostInputWithDate = remotePostToWpInput(
        input,
        categoryIds,
        tagIds,
        this.htmlOptions,
      );
      this.applyFeaturedMedia(wpInput, input.featureImage);

      if (input.status === 'scheduled') {
        // CreatePostInput has no publishedAt field — fall back to draft.
        // Callers that need scheduled posts should set the date via a raw update.
        console.warn(
          '[WordPressAdapter] createPost: status=scheduled but no publishedAt available in CreatePostInput; falling back to draft',
        );
        wpInput.status = 'draft';
      }

      const post = await this.api.createPost(wpInput);
      this.invalidateTaxonomyCache();

      const { tagNames, categoryNames } = await this.getTaxonomyMaps();
      const mediaUrl = post.featured_media !== 0
        ? (await this.api.getMedia(post.featured_media)).source_url
        : null;
      return wpPostToRemotePost(post, tagNames, categoryNames, mediaUrl, 'post');
    });
  }

  async updatePost(
    id: string,
    input: UpdatePostInput,
    baseVersion?: { updatedAt: string },
  ): Promise<RemotePost> {
    return this.translate(async () => {
      const numericId = Number(id);

      // Client-side optimistic lock: WP REST has no native conditional-update.
      // Fetch current modified_gmt and compare against the caller's baseVersion.
      const current = await this.api.getPost(numericId);
      if (baseVersion?.updatedAt && current.modified_gmt !== baseVersion.updatedAt) {
        throw new CmsApiError(
          `WordPress post ${id} was modified remotely (server: ${current.modified_gmt}, local: ${baseVersion.updatedAt})`,
          409,
          'conflict',
          WP_PLATFORM,
        );
      }

      // Only resolve taxonomy when the caller explicitly supplied tags.
      // Pass undefined to remotePostToWpInput so it omits the field entirely —
      // sending tags: [] to WP REST would silently clear existing tags.
      const resolvedTaxonomy = input.tags !== undefined
        ? await this.resolveTagsAndCategories(input.tags)
        : undefined;
      const wpInput: WpPostInputWithDate = remotePostToWpInput(
        input,
        resolvedTaxonomy?.categoryIds,
        resolvedTaxonomy?.tagIds,
        this.htmlOptions,
      );
      this.applyFeaturedMedia(wpInput, input.featureImage);

      if (input.status === 'scheduled') {
        // UpdatePostInput has no publishedAt field — fall back to draft.
        console.warn(
          '[WordPressAdapter] updatePost: status=scheduled but no publishedAt available in UpdatePostInput; falling back to draft',
        );
        wpInput.status = 'draft';
      }

      const post = await this.api.updatePost(numericId, wpInput);
      this.invalidateTaxonomyCache();

      const { tagNames, categoryNames } = await this.getTaxonomyMaps();
      const mediaUrl = post.featured_media !== 0
        ? (await this.api.getMedia(post.featured_media)).source_url
        : null;
      return wpPostToRemotePost(post, tagNames, categoryNames, mediaUrl, 'post');
    });
  }

  async deletePost(id: string): Promise<void> {
    return this.translate(async () => {
      // api.deletePost already appends ?force=true — bypasses WP trash to match
      // contract semantics (deleted = gone; subsequent getPost → 404).
      await this.api.deletePost(Number(id));
    });
  }

  async listContainers(): Promise<RemoteContainer[]> {
    // WordPress is a flat platform — no blog-container hierarchy.
    return [];
  }

  async listContent(options?: ListOptions): Promise<RemoteContentItem[]> {
    return this.translate(async () => {
      const kinds = options?.kinds ?? ['post', 'page'];
      const batches: Promise<RemoteContentItem[]>[] = [];
      if (kinds.includes('post')) {
        batches.push(this.listPosts(options) as Promise<RemoteContentItem[]>);
      }
      if (kinds.includes('page')) {
        batches.push(this.listPages(options));
      }
      return (await Promise.all(batches)).flat();
    });
  }

  async getContent(kind: ContentKind, id: string): Promise<RemoteContentItem> {
    if (kind === 'post') return this.getPost(id) as Promise<RemoteContentItem>;
    if (kind === 'page') return this.getPage(id);
    throw new CmsApiError(`WordPress content kind "${kind}" is not supported`, 400, 'unsupported_kind', WP_PLATFORM);
  }

  async createContent(input: CreateContentInput): Promise<RemoteContentItem> {
    if (input.kind === 'post') return this.createPost(input) as Promise<RemoteContentItem>;
    if (input.kind === 'page') return this.createPage(input);
    throw new CmsApiError(
      `WordPress content kind "${input.kind}" is not supported`,
      400,
      'unsupported_kind',
      WP_PLATFORM,
    );
  }

  async updateContent(
    kind: ContentKind,
    id: string,
    input: UpdateContentInput,
    baseVersion?: { updatedAt: string },
  ): Promise<RemoteContentItem> {
    if (kind === 'post') return this.updatePost(id, input, baseVersion) as Promise<RemoteContentItem>;
    if (kind === 'page') return this.updatePage(id, input, baseVersion);
    throw new CmsApiError(`WordPress content kind "${kind}" is not supported`, 400, 'unsupported_kind', WP_PLATFORM);
  }

  async deleteContent(kind: ContentKind, id: string): Promise<void> {
    if (kind === 'post') return this.deletePost(id);
    if (kind === 'page') {
      await this.api.deletePage(Number(id));
      return;
    }
    throw new CmsApiError(`WordPress content kind "${kind}" is not supported`, 400, 'unsupported_kind', WP_PLATFORM);
  }

  async uploadMedia(input: UploadMediaInput): Promise<RemoteMediaRef> {
    return this.translate(async () => {
      const media = await this.api.uploadMedia({
        file: input.file,
        filename: input.filename,
        mimeType: input.mimeType,
        alt: input.alt,
      });
      this.mediaIdByUrl.set(media.source_url, media.id);
      return {
        id: String(media.id),
        url: media.source_url,
        alt: input.alt ?? null,
        filename: input.filename,
        mimeType: input.mimeType,
        platform: WP_PLATFORM,
      };
    });
  }

  private async listPages(options?: ListOptions): Promise<RemoteContentItem[]> {
    const includeDrafts = options?.includeDrafts !== false;
    const includePublished = options?.includePublished !== false;
    const status = includeDrafts && includePublished
      ? 'any'
      : includeDrafts
        ? 'draft'
        : 'publish';
    const pages = await this.api.fetchPages({ status });
    const mediaUrls = await this.resolveMediaBatch(pages.map((p) => p.featured_media));
    return pages.map((page, i) =>
      wpPostToRemotePost(page, new Map(), new Map(), mediaUrls[i], 'page'),
    );
  }

  private async getPage(id: string): Promise<RemoteContentItem> {
    const page = await this.api.getPage(Number(id));
    const mediaUrl = page.featured_media !== 0
      ? (await this.api.getMedia(page.featured_media)).source_url
      : null;
    return wpPostToRemotePost(page, new Map(), new Map(), mediaUrl, 'page');
  }

  private async createPage(input: CreateContentInput): Promise<RemoteContentItem> {
    const wpInput = remotePostToWpInput(input, undefined, undefined, this.htmlOptions);
    this.applyFeaturedMedia(wpInput, input.featureImage);
    if (input.status === 'scheduled') wpInput.status = 'draft';
    const page = await this.api.createPage(wpInput);
    const mediaUrl = page.featured_media !== 0
      ? (await this.api.getMedia(page.featured_media)).source_url
      : null;
    return wpPostToRemotePost(page, new Map(), new Map(), mediaUrl, 'page');
  }

  private async updatePage(
    id: string,
    input: UpdateContentInput,
    baseVersion?: { updatedAt: string },
  ): Promise<RemoteContentItem> {
    const numericId = Number(id);
    const current = await this.api.getPage(numericId);
    if (baseVersion?.updatedAt && current.modified_gmt !== baseVersion.updatedAt) {
      throw new CmsApiError(
        `WordPress page ${id} was modified remotely (server: ${current.modified_gmt}, local: ${baseVersion.updatedAt})`,
        409,
        'conflict',
        WP_PLATFORM,
      );
    }

    const wpInput = remotePostToWpInput(input, undefined, undefined, this.htmlOptions);
    this.applyFeaturedMedia(wpInput, input.featureImage);
    if (input.status === 'scheduled') wpInput.status = 'draft';
    const page = await this.api.updatePage(numericId, wpInput);
    const mediaUrl = page.featured_media !== 0
      ? (await this.api.getMedia(page.featured_media)).source_url
      : null;
    return wpPostToRemotePost(page, new Map(), new Map(), mediaUrl, 'page');
  }

  // ---------------------------------------------------------------------------
  // Tag / category resolution
  // ---------------------------------------------------------------------------

  /** Split `RemotePost.tags` into WP category IDs and tag IDs.
   *  Entries prefixed with `cat:` are categories (prefix stripped);
   *  all others are plain tags. Names are resolved to IDs via the cache;
   *  tags/categories that don't exist yet are created on the fly (mirrors
   *  how Ghost auto-creates tags on post write). */
  private async resolveTagsAndCategories(
    tags: string[],
  ): Promise<{ categoryIds: number[]; tagIds: number[] }> {
    const catNames = tags.filter((t) => t.startsWith('cat:')).map((t) => t.slice(4));
    const tagNames = tags.filter((t) => !t.startsWith('cat:'));

    const { tags: wpTags, categories: wpCategories } = await this.getTaxonomy();

    const categoryIds: number[] = [];
    for (const name of catNames) {
      const existing = wpCategories.find((c) => c.name === name || c.slug === name);
      if (existing) {
        categoryIds.push(existing.id);
      } else {
        const created = await this.api.createCategory(name);
        categoryIds.push(created.id);
        this.invalidateTaxonomyCache();
      }
    }

    const tagIds: number[] = [];
    for (const name of tagNames) {
      const existing = wpTags.find((t) => t.name === name || t.slug === name);
      if (existing) {
        tagIds.push(existing.id);
      } else {
        const created = await this.api.createTag(name);
        tagIds.push(created.id);
        this.invalidateTaxonomyCache();
      }
    }

    return { categoryIds, tagIds };
  }

  private applyFeaturedMedia(input: WpPostInput, featureImage: string | null | undefined): void {
    if (!featureImage) return;
    const mediaId = this.mediaIdByUrl.get(featureImage);
    if (mediaId !== undefined) input.featured_media = mediaId;
  }

  private async getTaxonomyMaps(): Promise<{
    tagNames: Map<number, string>;
    categoryNames: Map<number, string>;
  }> {
    const { tags, categories } = await this.getTaxonomy();
    const tagNames = new Map(tags.map((t) => [t.id, t.name]));
    const categoryNames = new Map(categories.map((c) => [c.id, c.name]));
    return { tagNames, categoryNames };
  }

  private async getTaxonomy(): Promise<{ tags: WpTag[]; categories: WpCategory[] }> {
    const now = Date.now();
    const stale = !this.taxonomyCache || now - this.taxonomyCache.fetchedAt >= this.cacheTtlMs;

    if (!stale && this.taxonomyCache) {
      return this.taxonomyCache;
    }

    // Dedupe concurrent callers: if a fetch is in flight, reuse it.
    if (this.taxonomyPromise) return this.taxonomyPromise;

    this.taxonomyPromise = Promise.all([
      this.api.listTags(),
      this.api.listCategories(),
    ]).then(([tags, categories]) => {
      const cache: TaxonomyCache = { tags, categories, fetchedAt: Date.now() };
      this.taxonomyCache = cache;
      this.taxonomyPromise = null;
      return cache;
    }).catch((err) => {
      this.taxonomyPromise = null;
      throw err;
    });

    return this.taxonomyPromise;
  }

  private invalidateTaxonomyCache(): void {
    this.taxonomyCache = null;
    this.taxonomyPromise = null;
  }

  // ---------------------------------------------------------------------------
  // Featured image batch resolution
  // ---------------------------------------------------------------------------

  /** Resolve an array of featured_media IDs to URLs in parallel.
   *  Returns null for any ID === 0 (no featured image). */
  private async resolveMediaBatch(ids: number[]): Promise<(string | null)[]> {
    return Promise.all(
      ids.map((id) =>
        id !== 0
          ? this.api.getMedia(id).then((m) => m.source_url).catch(() => null)
          : Promise.resolve(null),
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // Error translation seam
  // ---------------------------------------------------------------------------

  /** Catch any error that slipped through the API client's translate() and
   *  ensure engine code always sees a uniform CmsApiError shape. */
  private async translate<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof CmsApiError) throw err;
      throw new CmsApiError(
        err instanceof Error ? err.message : String(err),
        0,
        undefined,
        WP_PLATFORM,
      );
    }
  }
}
