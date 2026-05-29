/**
 * Shopify implementation of CmsAdapter.
 *
 * Composes ShopifyApiClient + mapping. The mutation-time conversion of
 * `containerHandle` (blog handle) to `blogId` (gid) is cached on the
 * adapter so we don't refetch blogs on every push.
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
  RemotePost,
  UpdateContentInput,
  UpdatePostInput,
} from '../cms/types.js';
import { ShopifyApiClient, ShopifyBlog } from './api.js';
import {
  createInputToShopify,
  createPageInputToShopify,
  createProductInputToShopify,
  MarkdownToHtmlOptions,
  shopifyArticleToRemotePost,
  shopifyBlogToContainer,
  shopifyPageToRemotePost,
  shopifyProductToRemotePost,
  updateInputToShopify,
  updatePageInputToShopify,
  updateProductInputToShopify,
} from './mapping.js';

export interface ShopifyAdapterOptions extends MarkdownToHtmlOptions {
  /** TTL for the blog list cache in ms. Default 5 minutes. */
  blogCacheTtlMs?: number;
}

const DEFAULT_BLOG_CACHE_TTL_MS = 5 * 60 * 1000;

export class ShopifyAdapter implements CmsAdapter {
  readonly platform: Platform = 'shopify';

  /** In-flight or resolved blog list, with TTL. Dedupes concurrent callers and
   *  invalidates on `blog_not_found` so a new blog created in the admin is
   *  picked up without restarting the daemon. */
  private blogsPromise: Promise<ShopifyBlog[]> | null = null;
  private blogsFetchedAt = 0;
  private readonly blogCacheTtlMs: number;
  private readonly htmlOptions: MarkdownToHtmlOptions;

  constructor(
    private api: ShopifyApiClient,
    private shop: string,
    options: ShopifyAdapterOptions = {},
  ) {
    this.blogCacheTtlMs = options.blogCacheTtlMs ?? DEFAULT_BLOG_CACHE_TTL_MS;
    this.htmlOptions = { trustVaultContent: options.trustVaultContent };
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.api.testConnection();
      return { ok: true, message: `Connected to ${this.shop}` };
    } catch (err) {
      if (err instanceof CmsApiError) {
        if (err.isAuthError()) {
          return { ok: false, message: 'Authentication failed. Check your access token.' };
        }
        return { ok: false, message: `Shopify API error: ${err.message}` };
      }
      return { ok: false, message: `Connection failed: ${err}` };
    }
  }

  async listPosts(options?: ListOptions): Promise<RemotePost[]> {
    const includeDrafts = options?.includeDrafts !== false;
    const includePublished = options?.includePublished !== false;

    const apiOptions =
      includeDrafts && !includePublished
        ? { draftsOnly: true }
        : includePublished && !includeDrafts
          ? { publishedOnly: true }
          : {};

    const articles = await this.api.fetchAllArticles(apiOptions);
    return articles.map((a) => shopifyArticleToRemotePost(a, this.shop));
  }

  async getPost(id: string): Promise<RemotePost> {
    const article = await this.api.getArticle(id);
    return shopifyArticleToRemotePost(article, this.shop);
  }

  async createPost(input: CreatePostInput): Promise<RemotePost> {
    return this.withBlogRetry(async () => {
      const blogId = await this.resolveBlogId(input.containerHandle);
      const shopifyInput = createInputToShopify(input, blogId, this.htmlOptions);
      const article = await this.api.createArticle(shopifyInput);
      return shopifyArticleToRemotePost(article, this.shop);
    });
  }

  async updatePost(
    id: string,
    input: UpdatePostInput,
    _baseVersion?: { updatedAt: string },
  ): Promise<RemotePost> {
    // Shopify has no native optimistic-lock. baseVersion is intentionally ignored;
    // the engine layer handles client-side conflict detection (read-then-write).
    return this.withBlogRetry(async () => {
      const blogId = input.containerHandle
        ? await this.resolveBlogId(input.containerHandle)
        : undefined;
      const shopifyInput = updateInputToShopify(input, blogId, this.htmlOptions);
      const article = await this.api.updateArticle(id, shopifyInput);
      return shopifyArticleToRemotePost(article, this.shop);
    });
  }

  /** Wrap a call that may fail with blog_not_found (e.g. blog created in admin
   *  after we cached the list). Invalidates cache and retries once. */
  private async withBlogRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof CmsApiError && err.errorType === 'blog_not_found') {
        this.invalidateBlogCache();
        return fn();
      }
      throw err;
    }
  }

  async deletePost(id: string): Promise<void> {
    await this.api.deleteArticle(id);
  }

  async listContent(options?: ListOptions): Promise<RemoteContentItem[]> {
    const kinds = options?.kinds ?? ['article', 'page', 'product'];
    const includeDrafts = options?.includeDrafts !== false;
    const includePublished = options?.includePublished !== false;
    const apiOptions =
      includeDrafts && !includePublished
        ? { draftsOnly: true }
        : includePublished && !includeDrafts
          ? { publishedOnly: true }
          : {};

    const batches: Promise<RemoteContentItem[]>[] = [];
    if (kinds.includes('article') || kinds.includes('post')) {
      batches.push(
        this.api
          .fetchAllArticles(apiOptions)
          .then((articles) => articles.map((a) => shopifyArticleToRemotePost(a, this.shop) as RemoteContentItem)),
      );
    }
    if (kinds.includes('page')) {
      batches.push(
        this.api
          .fetchAllPages(apiOptions)
          .then((pages) => pages.map((p) => shopifyPageToRemotePost(p, this.shop))),
      );
    }
    if (kinds.includes('product')) {
      const productOptions =
        includeDrafts && !includePublished
          ? { draftsOnly: true }
          : includePublished && !includeDrafts
            ? { activeOnly: true }
            : {};
      batches.push(
        this.api
          .fetchAllProducts(productOptions)
          .then((products) => products.map(shopifyProductToRemotePost)),
      );
    }
    return (await Promise.all(batches)).flat();
  }

  async getContent(kind: ContentKind, id: string): Promise<RemoteContentItem> {
    if (kind === 'article' || kind === 'post') {
      return shopifyArticleToRemotePost(await this.api.getArticle(id), this.shop) as RemoteContentItem;
    }
    if (kind === 'page') {
      return shopifyPageToRemotePost(await this.api.getPage(id), this.shop);
    }
    if (kind === 'product') {
      return shopifyProductToRemotePost(await this.api.getProduct(id));
    }
    throw new CmsApiError(`Shopify content kind "${kind}" is not supported`, 400, 'unsupported_kind', 'shopify');
  }

  async createContent(input: CreateContentInput): Promise<RemoteContentItem> {
    if (input.kind === 'article' || input.kind === 'post') {
      return this.createPost(input) as Promise<RemoteContentItem>;
    }
    if (input.kind === 'page') {
      const page = await this.api.createPage(createPageInputToShopify(input, this.htmlOptions));
      return shopifyPageToRemotePost(page, this.shop);
    }
    if (input.kind === 'product') {
      const product = await this.api.createProduct(
        createProductInputToShopify(input, this.htmlOptions),
      );
      return shopifyProductToRemotePost(product);
    }
    throw new CmsApiError(
      `Shopify content kind "${input.kind}" is not supported`,
      400,
      'unsupported_kind',
      'shopify',
    );
  }

  async updateContent(
    kind: ContentKind,
    id: string,
    input: UpdateContentInput,
    baseVersion?: { updatedAt: string },
  ): Promise<RemoteContentItem> {
    if (kind === 'article' || kind === 'post') {
      return this.updatePost(id, input, baseVersion) as Promise<RemoteContentItem>;
    }
    if (kind === 'page') {
      const page = await this.api.updatePage(id, updatePageInputToShopify(input, this.htmlOptions));
      return shopifyPageToRemotePost(page, this.shop);
    }
    if (kind === 'product') {
      const product = await this.api.updateProduct(
        id,
        updateProductInputToShopify(input, this.htmlOptions),
      );
      return shopifyProductToRemotePost(product);
    }
    throw new CmsApiError(`Shopify content kind "${kind}" is not supported`, 400, 'unsupported_kind', 'shopify');
  }

  async deleteContent(kind: ContentKind, id: string): Promise<void> {
    if (kind === 'article' || kind === 'post') {
      await this.api.deleteArticle(id);
      return;
    }
    if (kind === 'page') {
      await this.api.deletePage(id);
      return;
    }
    if (kind === 'product') {
      await this.api.deleteProduct(id);
      return;
    }
    throw new CmsApiError(`Shopify content kind "${kind}" is not supported`, 400, 'unsupported_kind', 'shopify');
  }

  async listContainers(): Promise<RemoteContainer[]> {
    const blogs = await this.getBlogs();
    return blogs.map(shopifyBlogToContainer);
  }

  /** Resolve a blog handle to its gid. If `handle` is omitted, returns the
   *  first blog's id (Shopify stores ship with one default blog, "News"). */
  private async resolveBlogId(handle?: string): Promise<string> {
    const blogs = await this.getBlogs();
    if (blogs.length === 0) {
      throw new CmsApiError(
        'Shop has no blogs; create one first via Shopify admin or listContainers + createBlog.',
        404,
        'no_blogs',
        'shopify',
      );
    }
    if (!handle) return blogs[0].id;
    const match = blogs.find((b) => b.handle === handle);
    if (!match) {
      throw new CmsApiError(
        `Blog with handle "${handle}" not found. Available: ${blogs.map((b) => b.handle).join(', ')}`,
        404,
        'blog_not_found',
        'shopify',
      );
    }
    return match.id;
  }

  private async getBlogs(): Promise<ShopifyBlog[]> {
    // blogsFetchedAt is set at fetch *start*, not resolution. This way the
    // "fresh" check naturally dedupes concurrent callers AND honors TTL,
    // without a separate in-flight flag. On failure we clear so the next
    // caller retries.
    const stale = Date.now() - this.blogsFetchedAt >= this.blogCacheTtlMs;
    if (this.blogsPromise && !stale) return this.blogsPromise;
    this.blogsFetchedAt = Date.now();
    this.blogsPromise = this.api.listBlogs();
    this.blogsPromise.catch(() => {
      this.blogsPromise = null;
      this.blogsFetchedAt = 0;
    });
    return this.blogsPromise;
  }

  /** For tests or callers that know a new blog was created out of band. */
  invalidateBlogCache(): void {
    this.blogsPromise = null;
    this.blogsFetchedAt = 0;
  }
}
