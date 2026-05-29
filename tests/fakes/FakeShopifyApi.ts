/**
 * In-memory Shopify Admin API stand-in for tests.
 *
 * Extends `ShopifyApiClient` so it's accepted by `ShopifyAdapter`'s
 * constructor (typed against the real class). Every method the adapter
 * calls is overridden — `super.*` is never invoked, so the fake never
 * makes real HTTP requests. The parent constructor IS invoked with stub
 * values to satisfy the validation in `ShopifyApiClient`; this is safe
 * today but will need revisiting if the real constructor grows side
 * effects (DNS lookup, auth probe). Tracked as part of the engine-refactor
 * milestone: lift fakes to `implements CmsAdapter` rather than `extends`
 * the real client.
 */

import {
  ShopifyApiClient,
  ShopifyArticle,
  ShopifyArticleInput,
  ShopifyBlog,
  ShopifyPage,
  ShopifyPageInput,
  ShopifyProduct,
  ShopifyProductInput,
} from '../../src/shopify/api.js';
import { CmsApiError } from '../../src/cms/types.js';

let idSeq = 1000;
const nextId = (kind: 'Blog' | 'Article' | 'Page' | 'Product') => `gid://shopify/${kind}/${++idSeq}`;

export function makeShopifyArticle(overrides: Partial<ShopifyArticle> = {}): ShopifyArticle {
  const id = overrides.id ?? nextId('Article');
  const now = new Date().toISOString();
  return {
    id,
    title: overrides.title ?? 'Untitled',
    handle: overrides.handle ?? 'untitled',
    body: overrides.body ?? '<p>Body</p>',
    summary: overrides.summary ?? null,
    author: overrides.author ?? { name: 'Author' },
    tags: overrides.tags ?? [],
    publishedAt: overrides.publishedAt ?? null,
    isPublished: overrides.isPublished ?? false,
    image: overrides.image ?? null,
    blog: overrides.blog ?? { id: 'gid://shopify/Blog/1', handle: 'news', title: 'News' },
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    templateSuffix: overrides.templateSuffix ?? null,
  };
}

export function makeShopifyBlog(overrides: Partial<ShopifyBlog> = {}): ShopifyBlog {
  const id = overrides.id ?? nextId('Blog');
  return {
    id,
    handle: overrides.handle ?? 'news',
    title: overrides.title ?? 'News',
    commentPolicy: overrides.commentPolicy ?? 'CLOSED',
    templateSuffix: overrides.templateSuffix ?? null,
  };
}

export function makeShopifyPage(overrides: Partial<ShopifyPage> = {}): ShopifyPage {
  const id = overrides.id ?? nextId('Page');
  const now = new Date().toISOString();
  return {
    id,
    title: overrides.title ?? 'Untitled page',
    handle: overrides.handle ?? 'untitled-page',
    body: overrides.body ?? '<p>Body</p>',
    bodySummary: overrides.bodySummary ?? null,
    isPublished: overrides.isPublished ?? false,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    publishedAt: overrides.publishedAt ?? null,
    templateSuffix: overrides.templateSuffix ?? null,
  };
}

export function makeShopifyProduct(overrides: Partial<ShopifyProduct> = {}): ShopifyProduct {
  const id = overrides.id ?? nextId('Product');
  const now = new Date().toISOString();
  return {
    id,
    title: overrides.title ?? 'Untitled product',
    handle: overrides.handle ?? 'untitled-product',
    descriptionHtml: overrides.descriptionHtml ?? '<p>Description</p>',
    status: overrides.status ?? 'DRAFT',
    tags: overrides.tags ?? [],
    featuredMedia: overrides.featuredMedia ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    onlineStoreUrl: overrides.onlineStoreUrl ?? null,
  };
}

export class FakeShopifyApi extends ShopifyApiClient {
  blogs: ShopifyBlog[] = [];
  articles = new Map<string, ShopifyArticle>();
  pages = new Map<string, ShopifyPage>();
  products = new Map<string, ShopifyProduct>();
  productVariants = new Map<string, unknown>();
  public createCount = 0;
  public updateCount = 0;
  public deleteCount = 0;
  public listBlogsCount = 0;

  constructor() {
    super('fake.myshopify.com', 'shpat_fake', '2026-01');
  }

  seedDefaultBlog(): ShopifyBlog {
    const blog = makeShopifyBlog({ id: 'gid://shopify/Blog/1', handle: 'news', title: 'News' });
    this.blogs = [blog];
    return blog;
  }

  seedArticle(overrides: Partial<ShopifyArticle> = {}): ShopifyArticle {
    const article = makeShopifyArticle(overrides);
    this.articles.set(article.id, article);
    return article;
  }

  seedPage(overrides: Partial<ShopifyPage> = {}): ShopifyPage {
    const page = makeShopifyPage(overrides);
    this.pages.set(page.id, page);
    return page;
  }

  seedProduct(overrides: Partial<ShopifyProduct> = {}, variants: unknown = [{ id: 'variant-1', price: '99.00' }]): ShopifyProduct {
    const product = makeShopifyProduct(overrides);
    this.products.set(product.id, product);
    this.productVariants.set(product.id, variants);
    return product;
  }

  override async testConnection(): Promise<void> {
    // no-op
  }

  override async listBlogs(): Promise<ShopifyBlog[]> {
    this.listBlogsCount++;
    return [...this.blogs];
  }

  override async createBlog(input: { title: string; handle?: string }): Promise<ShopifyBlog> {
    const blog = makeShopifyBlog({ title: input.title, handle: input.handle ?? 'new-blog' });
    this.blogs.push(blog);
    return blog;
  }

  override async fetchAllArticles(options?: {
    blogId?: string;
    publishedOnly?: boolean;
    draftsOnly?: boolean;
  }): Promise<ShopifyArticle[]> {
    let list = Array.from(this.articles.values());
    if (options?.blogId) {
      list = list.filter((a) => a.blog.id.endsWith(`/${options.blogId}`));
    }
    if (options?.publishedOnly) list = list.filter((a) => a.isPublished);
    if (options?.draftsOnly) list = list.filter((a) => !a.isPublished);
    return list;
  }

  override async getArticle(id: string): Promise<ShopifyArticle> {
    const a = this.articles.get(id);
    if (!a) throw new CmsApiError(`Article ${id} not found`, 404, 'not_found', 'shopify');
    return a;
  }

  override async createArticle(input: ShopifyArticleInput): Promise<ShopifyArticle> {
    this.createCount++;
    if (!input.blogId) {
      throw new CmsApiError('createArticle requires blogId', 400, 'missing_blog', 'shopify');
    }
    const blog = this.blogs.find((b) => b.id === input.blogId);
    if (!blog) {
      throw new CmsApiError('blog not found', 404, 'blog_not_found', 'shopify');
    }
    const article = makeShopifyArticle({
      title: input.title ?? 'Untitled',
      handle: input.handle ?? 'untitled',
      body: input.body ?? '',
      summary: input.summary ?? null,
      author: input.author ?? null,
      tags: input.tags ?? [],
      image: input.image ? { url: input.image.url, altText: input.image.altText ?? null } : null,
      isPublished: input.isPublished ?? false,
      publishedAt: input.isPublished ? new Date().toISOString() : null,
      blog: { id: blog.id, handle: blog.handle, title: blog.title },
    });
    this.articles.set(article.id, article);
    return article;
  }

  override async updateArticle(id: string, input: ShopifyArticleInput): Promise<ShopifyArticle> {
    this.updateCount++;
    const existing = this.articles.get(id);
    if (!existing) throw new CmsApiError(`Article ${id} not found`, 404, 'not_found', 'shopify');
    let blog = existing.blog;
    if (input.blogId) {
      const target = this.blogs.find((b) => b.id === input.blogId);
      if (!target) throw new CmsApiError('blog not found', 404, 'blog_not_found', 'shopify');
      blog = { id: target.id, handle: target.handle, title: target.title };
    }
    const updated: ShopifyArticle = {
      ...existing,
      title: input.title ?? existing.title,
      handle: input.handle ?? existing.handle,
      body: input.body ?? existing.body,
      summary: input.summary !== undefined ? input.summary : existing.summary,
      author: input.author ?? existing.author,
      tags: input.tags ?? existing.tags,
      image:
        input.image === undefined
          ? existing.image
          : input.image === null
            ? null
            : { url: input.image.url, altText: input.image.altText ?? null },
      isPublished: input.isPublished ?? existing.isPublished,
      publishedAt:
        input.isPublished && !existing.isPublished
          ? new Date().toISOString()
          : existing.publishedAt,
      blog,
      updatedAt: new Date().toISOString(),
    };
    this.articles.set(id, updated);
    return updated;
  }

  override async deleteArticle(id: string): Promise<void> {
    this.deleteCount++;
    if (!this.articles.has(id)) {
      throw new CmsApiError(`Article ${id} not found`, 404, 'not_found', 'shopify');
    }
    this.articles.delete(id);
  }

  override async fetchAllPages(options?: {
    publishedOnly?: boolean;
    draftsOnly?: boolean;
  }): Promise<ShopifyPage[]> {
    let list = Array.from(this.pages.values());
    if (options?.publishedOnly) list = list.filter((p) => p.isPublished);
    if (options?.draftsOnly) list = list.filter((p) => !p.isPublished);
    return list;
  }

  override async getPage(id: string): Promise<ShopifyPage> {
    const p = this.pages.get(id);
    if (!p) throw new CmsApiError(`Page ${id} not found`, 404, 'not_found', 'shopify');
    return p;
  }

  override async createPage(input: ShopifyPageInput): Promise<ShopifyPage> {
    this.createCount++;
    const page = makeShopifyPage({
      title: input.title ?? 'Untitled page',
      handle: input.handle ?? 'untitled-page',
      body: input.body ?? '',
      isPublished: input.isPublished ?? false,
      publishedAt: input.isPublished ? new Date().toISOString() : null,
      templateSuffix: input.templateSuffix ?? null,
    });
    this.pages.set(page.id, page);
    return page;
  }

  override async updatePage(id: string, input: ShopifyPageInput): Promise<ShopifyPage> {
    this.updateCount++;
    const existing = this.pages.get(id);
    if (!existing) throw new CmsApiError(`Page ${id} not found`, 404, 'not_found', 'shopify');
    const updated: ShopifyPage = {
      ...existing,
      title: input.title ?? existing.title,
      handle: input.handle ?? existing.handle,
      body: input.body ?? existing.body,
      isPublished: input.isPublished ?? existing.isPublished,
      publishedAt:
        input.isPublished && !existing.isPublished
          ? new Date().toISOString()
          : existing.publishedAt,
      templateSuffix: input.templateSuffix ?? existing.templateSuffix,
      updatedAt: new Date().toISOString(),
    };
    this.pages.set(id, updated);
    return updated;
  }

  override async deletePage(id: string): Promise<void> {
    this.deleteCount++;
    if (!this.pages.has(id)) {
      throw new CmsApiError(`Page ${id} not found`, 404, 'not_found', 'shopify');
    }
    this.pages.delete(id);
  }

  override async fetchAllProducts(options?: {
    activeOnly?: boolean;
    draftsOnly?: boolean;
  }): Promise<ShopifyProduct[]> {
    let list = Array.from(this.products.values());
    if (options?.activeOnly) list = list.filter((p) => p.status === 'ACTIVE');
    if (options?.draftsOnly) list = list.filter((p) => p.status === 'DRAFT');
    return list;
  }

  override async getProduct(id: string): Promise<ShopifyProduct> {
    const p = this.products.get(id);
    if (!p) throw new CmsApiError(`Product ${id} not found`, 404, 'not_found', 'shopify');
    return p;
  }

  override async createProduct(input: ShopifyProductInput): Promise<ShopifyProduct> {
    this.createCount++;
    const product = makeShopifyProduct({
      title: input.title ?? 'Untitled product',
      handle: input.handle ?? 'untitled-product',
      descriptionHtml: input.descriptionHtml ?? '',
      status: input.status ?? 'DRAFT',
      tags: input.tags ?? [],
      onlineStoreUrl: input.status === 'ACTIVE'
        ? `https://fake.myshopify.com/products/${input.handle ?? 'untitled-product'}`
        : null,
    });
    this.products.set(product.id, product);
    this.productVariants.set(product.id, [{ id: 'default-variant' }]);
    return product;
  }

  override async updateProduct(id: string, input: ShopifyProductInput): Promise<ShopifyProduct> {
    this.updateCount++;
    const existing = this.products.get(id);
    if (!existing) throw new CmsApiError(`Product ${id} not found`, 404, 'not_found', 'shopify');
    const handle = input.handle ?? existing.handle;
    const status = input.status ?? existing.status;
    const updated: ShopifyProduct = {
      ...existing,
      title: input.title ?? existing.title,
      handle,
      descriptionHtml: input.descriptionHtml ?? existing.descriptionHtml,
      status,
      tags: input.tags ?? existing.tags,
      onlineStoreUrl: status === 'ACTIVE'
        ? `https://fake.myshopify.com/products/${handle}`
        : null,
      updatedAt: new Date().toISOString(),
    };
    this.products.set(id, updated);
    return updated;
  }

  override async deleteProduct(id: string): Promise<void> {
    this.deleteCount++;
    if (!this.products.has(id)) {
      throw new CmsApiError(`Product ${id} not found`, 404, 'not_found', 'shopify');
    }
    this.products.delete(id);
    this.productVariants.delete(id);
  }
}
