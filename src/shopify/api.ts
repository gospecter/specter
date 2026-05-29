/**
 * Shopify Admin GraphQL API client.
 *
 * Auth: `X-Shopify-Access-Token` header. Token is either a dev-store
 * `shpat_…` (Dev Dashboard custom-distribution) or an OAuth-issued access
 * token (production). Both have identical wire usage.
 *
 * Empirically confirmed (2026-05-24 spike, see scripts/shopify-spike-report.md):
 *  - Article.body is essentially raw passthrough on the API path (the admin
 *    UI's TinyMCE sanitizer does NOT apply); only minor normalization
 *    (entity decoding, whitespace inside tables) happens.
 *  - `articleUpdate` with new `blogId` physically moves the article.
 *  - Top-level `articles` query spans blogs; filter with `blog_id:<numeric>`.
 *  - Custom `handle` is honored exactly and survives title changes.
 */

import { CmsApiError } from '../cms/types.js';

export const DEFAULT_API_VERSION = '2026-01';

/** Parse a `Retry-After` header. Spec allows seconds-as-int or HTTP-date. */
function parseRetryAfter(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const asInt = Number(raw);
  if (Number.isFinite(asInt)) return Math.max(0, asInt * 1000);
  const asDate = Date.parse(raw);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return undefined;
}

export interface ShopifyAuthor {
  name: string;
}

export interface ShopifyImage {
  url: string;
  altText: string | null;
}

export interface ShopifyBlogRef {
  id: string;
  handle: string;
  title?: string;
}

export interface ShopifyArticle {
  id: string;
  title: string;
  handle: string;
  body: string;
  summary: string | null;
  author: ShopifyAuthor | null;
  tags: string[];
  publishedAt: string | null;
  isPublished: boolean;
  image: ShopifyImage | null;
  blog: ShopifyBlogRef;
  createdAt: string;
  updatedAt: string | null;
  templateSuffix: string | null;
}

export interface ShopifyBlog {
  id: string;
  handle: string;
  title: string;
  commentPolicy: 'MODERATED' | 'AUTO_PUBLISHED' | 'CLOSED';
  templateSuffix: string | null;
}

export interface ShopifyArticleInput {
  blogId?: string;
  title?: string;
  handle?: string;
  body?: string;
  summary?: string | null;
  author?: ShopifyAuthor;
  tags?: string[];
  image?: { url: string; altText?: string } | null;
  isPublished?: boolean;
  publishDate?: string;
  templateSuffix?: string;
  redirectNewHandle?: boolean;
}

export interface ShopifyPage {
  id: string;
  title: string;
  handle: string;
  body: string;
  bodySummary: string | null;
  isPublished: boolean;
  createdAt: string;
  updatedAt: string | null;
  publishedAt: string | null;
  templateSuffix: string | null;
}

export interface ShopifyPageInput {
  title?: string;
  handle?: string;
  body?: string;
  isPublished?: boolean;
  templateSuffix?: string;
}

export type ShopifyProductStatus = 'ACTIVE' | 'DRAFT' | 'ARCHIVED';

export interface ShopifyProduct {
  id: string;
  title: string;
  handle: string;
  descriptionHtml: string;
  status: ShopifyProductStatus;
  tags: string[];
  featuredMedia: { preview: { image: ShopifyImage | null } | null } | null;
  createdAt: string;
  updatedAt: string | null;
  onlineStoreUrl: string | null;
}

export interface ShopifyProductInput {
  title?: string;
  handle?: string;
  descriptionHtml?: string;
  status?: ShopifyProductStatus;
  tags?: string[];
}

const ARTICLE_FIELDS = `
  id title handle body summary
  author { name }
  tags
  publishedAt isPublished templateSuffix
  image { url altText }
  blog { id handle title }
  createdAt updatedAt
`;

const PAGE_FIELDS = `
  id title handle body bodySummary
  isPublished createdAt updatedAt publishedAt templateSuffix
`;

const PRODUCT_FIELDS = `
  id title handle descriptionHtml status tags
  featuredMedia { preview { image { url altText } } }
  createdAt updatedAt onlineStoreUrl
`;

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
  extensions?: {
    cost?: {
      requestedQueryCost?: number;
      actualQueryCost?: number;
      throttleStatus?: {
        maximumAvailable: number;
        currentlyAvailable: number;
        restoreRate: number;
      };
    };
  };
}

interface UserError {
  code?: string;
  field?: string[] | null;
  message: string;
}

export class ShopifyApiClient {
  private endpoint: string;

  constructor(
    private shop: string,
    private accessToken: string,
    public readonly apiVersion: string = DEFAULT_API_VERSION,
  ) {
    if (!shop || !accessToken) {
      throw new Error('ShopifyApiClient requires both shop and accessToken');
    }
    this.endpoint = `https://${shop.replace(/^https?:\/\//, '').replace(/\/$/, '')}/admin/api/${apiVersion}/graphql.json`;
  }

  private async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': this.accessToken,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 401 || res.status === 403) {
      throw new CmsApiError(
        `Shopify auth failed (HTTP ${res.status})`,
        res.status,
        'auth',
        'shopify',
      );
    }

    // 429: standard rate limit. 430: Shopify shop-protection throttle.
    // 402: store payment issue (frozen). Surface all three as typed errors.
    if (res.status === 429 || res.status === 430) {
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
      throw new CmsApiError(
        `Shopify rate-limited (HTTP ${res.status})`,
        res.status,
        'rate_limited',
        'shopify',
        retryAfter,
      );
    }
    if (res.status === 402) {
      throw new CmsApiError(
        'Shopify shop payment required (HTTP 402) — likely frozen or past-due',
        402,
        'payment_required',
        'shopify',
      );
    }

    const text = await res.text();
    let parsed: GraphQLResponse<T> | null = null;
    try {
      parsed = text ? (JSON.parse(text) as GraphQLResponse<T>) : null;
    } catch {
      throw new CmsApiError(
        `Shopify returned non-JSON: ${text.slice(0, 200)}`,
        res.status,
        'parse',
        'shopify',
      );
    }

    if (!res.ok) {
      const msg = parsed?.errors?.[0]?.message ?? `HTTP ${res.status}`;
      throw new CmsApiError(msg, res.status, parsed?.errors?.[0]?.extensions?.code, 'shopify');
    }

    if (parsed?.errors?.length) {
      const firstCode = parsed.errors[0].extensions?.code;
      // THROTTLED is the GraphQL-level rate-limit signal. Restore rate is in
      // extensions.cost.throttleStatus.restoreRate (points/second).
      if (firstCode === 'THROTTLED') {
        const restoreRate = parsed.extensions?.cost?.throttleStatus?.restoreRate;
        const retryAfter = restoreRate ? Math.ceil(1000 / restoreRate) : 1000;
        throw new CmsApiError(
          'Shopify GraphQL throttled',
          200,
          'rate_limited',
          'shopify',
          retryAfter,
        );
      }
      throw new CmsApiError(
        parsed.errors.map((e) => e.message).join('; '),
        200,
        firstCode ?? 'graphql',
        'shopify',
      );
    }

    if (!parsed?.data) {
      throw new CmsApiError('Shopify returned no data', res.status, 'empty', 'shopify');
    }
    return parsed.data;
  }

  private failOnUserErrors(name: string, errors: UserError[] | undefined): void {
    if (!errors || errors.length === 0) return;
    const first = errors[0];
    const isNotFound = first.code === 'NOT_FOUND' || /not found/i.test(first.message);
    throw new CmsApiError(
      `${name}: ${errors.map((e) => `${e.field?.join('.') ?? ''}: ${e.message}`).join('; ')}`,
      isNotFound ? 404 : 422,
      first.code ?? 'user_error',
      'shopify',
    );
  }

  async testConnection(): Promise<void> {
    await this.gql<{ shop: { id: string; name: string } }>(`{ shop { id name } }`);
  }

  async listBlogs(): Promise<ShopifyBlog[]> {
    const data = await this.gql<{ blogs: { nodes: ShopifyBlog[] } }>(
      `query { blogs(first: 50) {
        nodes { id handle title commentPolicy templateSuffix }
      } }`,
    );
    return data.blogs.nodes;
  }

  async createBlog(input: { title: string; handle?: string }): Promise<ShopifyBlog> {
    const data = await this.gql<{
      blogCreate: { blog: ShopifyBlog; userErrors: UserError[] };
    }>(
      `mutation($blog: BlogCreateInput!) {
        blogCreate(blog: $blog) {
          blog { id handle title commentPolicy templateSuffix }
          userErrors { code field message }
        }
      }`,
      { blog: input },
    );
    this.failOnUserErrors('blogCreate', data.blogCreate.userErrors);
    return data.blogCreate.blog;
  }

  /**
   * List all articles in the shop, paginated across all blogs by default.
   * Pass `blogId` (in numeric form, e.g. "119296622907") to filter.
   */
  async fetchAllArticles(options?: {
    blogId?: string;
    publishedOnly?: boolean;
    draftsOnly?: boolean;
  }): Promise<ShopifyArticle[]> {
    const all: ShopifyArticle[] = [];
    let cursor: string | null = null;
    const queryParts: string[] = [];
    if (options?.blogId) queryParts.push(`blog_id:${options.blogId}`);
    if (options?.publishedOnly) queryParts.push('published_status:published');
    else if (options?.draftsOnly) queryParts.push('published_status:unpublished');
    const filterStr = queryParts.join(' AND ');

    while (true) {
      const data: { articles: { nodes: ShopifyArticle[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await this.gql(
        `query($first: Int!, $after: String, $query: String) {
          articles(first: $first, after: $after, query: $query) {
            nodes { ${ARTICLE_FIELDS} }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { first: 50, after: cursor, query: filterStr || null },
      );
      all.push(...data.articles.nodes);
      if (!data.articles.pageInfo.hasNextPage) break;
      cursor = data.articles.pageInfo.endCursor;
      if (!cursor) break;
    }
    return all;
  }

  async getArticle(id: string): Promise<ShopifyArticle> {
    const data = await this.gql<{ article: ShopifyArticle | null }>(
      `query($id: ID!) {
        article(id: $id) { ${ARTICLE_FIELDS} }
      }`,
      { id },
    );
    if (!data.article) {
      throw new CmsApiError(`Article ${id} not found`, 404, 'not_found', 'shopify');
    }
    return data.article;
  }

  async createArticle(input: ShopifyArticleInput): Promise<ShopifyArticle> {
    if (!input.blogId) {
      throw new CmsApiError(
        'createArticle requires blogId',
        400,
        'missing_blog',
        'shopify',
      );
    }
    const data = await this.gql<{
      articleCreate: { article: ShopifyArticle | null; userErrors: UserError[] };
    }>(
      `mutation($article: ArticleCreateInput!) {
        articleCreate(article: $article) {
          article { ${ARTICLE_FIELDS} }
          userErrors { code field message }
        }
      }`,
      { article: input },
    );
    this.failOnUserErrors('articleCreate', data.articleCreate.userErrors);
    if (!data.articleCreate.article) {
      throw new CmsApiError('articleCreate returned null', 500, 'null_article', 'shopify');
    }
    return data.articleCreate.article;
  }

  async updateArticle(id: string, input: ShopifyArticleInput): Promise<ShopifyArticle> {
    const data = await this.gql<{
      articleUpdate: { article: ShopifyArticle | null; userErrors: UserError[] };
    }>(
      `mutation($id: ID!, $article: ArticleUpdateInput!) {
        articleUpdate(id: $id, article: $article) {
          article { ${ARTICLE_FIELDS} }
          userErrors { code field message }
        }
      }`,
      { id, article: input },
    );
    this.failOnUserErrors('articleUpdate', data.articleUpdate.userErrors);
    if (!data.articleUpdate.article) {
      throw new CmsApiError('articleUpdate returned null', 500, 'null_article', 'shopify');
    }
    return data.articleUpdate.article;
  }

  async deleteArticle(id: string): Promise<void> {
    const data = await this.gql<{
      articleDelete: { deletedArticleId: string | null; userErrors: UserError[] };
    }>(
      `mutation($id: ID!) {
        articleDelete(id: $id) {
          deletedArticleId
          userErrors { code field message }
        }
      }`,
      { id },
    );
    this.failOnUserErrors('articleDelete', data.articleDelete.userErrors);
  }

  async fetchAllPages(options?: {
    publishedOnly?: boolean;
    draftsOnly?: boolean;
  }): Promise<ShopifyPage[]> {
    const all: ShopifyPage[] = [];
    let cursor: string | null = null;
    const query = options?.publishedOnly
      ? 'published_status:published'
      : options?.draftsOnly
        ? 'published_status:unpublished'
        : null;

    while (true) {
      const data: { pages: { nodes: ShopifyPage[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await this.gql(
        `query($first: Int!, $after: String, $query: String) {
          pages(first: $first, after: $after, query: $query) {
            nodes { ${PAGE_FIELDS} }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { first: 50, after: cursor, query },
      );
      all.push(...data.pages.nodes);
      if (!data.pages.pageInfo.hasNextPage) break;
      cursor = data.pages.pageInfo.endCursor;
      if (!cursor) break;
    }
    return all;
  }

  async getPage(id: string): Promise<ShopifyPage> {
    const data = await this.gql<{ page: ShopifyPage | null }>(
      `query($id: ID!) {
        page(id: $id) { ${PAGE_FIELDS} }
      }`,
      { id },
    );
    if (!data.page) {
      throw new CmsApiError(`Page ${id} not found`, 404, 'not_found', 'shopify');
    }
    return data.page;
  }

  async createPage(input: ShopifyPageInput): Promise<ShopifyPage> {
    const data = await this.gql<{
      pageCreate: { page: ShopifyPage | null; userErrors: UserError[] };
    }>(
      `mutation($page: PageCreateInput!) {
        pageCreate(page: $page) {
          page { ${PAGE_FIELDS} }
          userErrors { code field message }
        }
      }`,
      { page: input },
    );
    this.failOnUserErrors('pageCreate', data.pageCreate.userErrors);
    if (!data.pageCreate.page) {
      throw new CmsApiError('pageCreate returned null', 500, 'null_page', 'shopify');
    }
    return data.pageCreate.page;
  }

  async updatePage(id: string, input: ShopifyPageInput): Promise<ShopifyPage> {
    const data = await this.gql<{
      pageUpdate: { page: ShopifyPage | null; userErrors: UserError[] };
    }>(
      `mutation($id: ID!, $page: PageUpdateInput!) {
        pageUpdate(id: $id, page: $page) {
          page { ${PAGE_FIELDS} }
          userErrors { code field message }
        }
      }`,
      { id, page: input },
    );
    this.failOnUserErrors('pageUpdate', data.pageUpdate.userErrors);
    if (!data.pageUpdate.page) {
      throw new CmsApiError('pageUpdate returned null', 500, 'null_page', 'shopify');
    }
    return data.pageUpdate.page;
  }

  async deletePage(id: string): Promise<void> {
    const data = await this.gql<{
      pageDelete: { deletedPageId: string | null; userErrors: UserError[] };
    }>(
      `mutation($id: ID!) {
        pageDelete(id: $id) {
          deletedPageId
          userErrors { code field message }
        }
      }`,
      { id },
    );
    this.failOnUserErrors('pageDelete', data.pageDelete.userErrors);
  }

  async fetchAllProducts(options?: {
    activeOnly?: boolean;
    draftsOnly?: boolean;
  }): Promise<ShopifyProduct[]> {
    const all: ShopifyProduct[] = [];
    let cursor: string | null = null;
    const query = options?.activeOnly
      ? 'status:active'
      : options?.draftsOnly
        ? 'status:draft'
        : null;

    while (true) {
      const data: { products: { nodes: ShopifyProduct[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await this.gql(
        `query($first: Int!, $after: String, $query: String) {
          products(first: $first, after: $after, query: $query) {
            nodes { ${PRODUCT_FIELDS} }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { first: 50, after: cursor, query },
      );
      all.push(...data.products.nodes);
      if (!data.products.pageInfo.hasNextPage) break;
      cursor = data.products.pageInfo.endCursor;
      if (!cursor) break;
    }
    return all;
  }

  async getProduct(id: string): Promise<ShopifyProduct> {
    const data = await this.gql<{ product: ShopifyProduct | null }>(
      `query($id: ID!) {
        product(id: $id) { ${PRODUCT_FIELDS} }
      }`,
      { id },
    );
    if (!data.product) {
      throw new CmsApiError(`Product ${id} not found`, 404, 'not_found', 'shopify');
    }
    return data.product;
  }

  async createProduct(input: ShopifyProductInput): Promise<ShopifyProduct> {
    const data = await this.gql<{
      productCreate: { product: ShopifyProduct | null; userErrors: UserError[] };
    }>(
      `mutation($product: ProductCreateInput!) {
        productCreate(product: $product) {
          product { ${PRODUCT_FIELDS} }
          userErrors { code field message }
        }
      }`,
      { product: input },
    );
    this.failOnUserErrors('productCreate', data.productCreate.userErrors);
    if (!data.productCreate.product) {
      throw new CmsApiError('productCreate returned null', 500, 'null_product', 'shopify');
    }
    return data.productCreate.product;
  }

  async updateProduct(id: string, input: ShopifyProductInput): Promise<ShopifyProduct> {
    const data = await this.gql<{
      productUpdate: { product: ShopifyProduct | null; userErrors: UserError[] };
    }>(
      `mutation($id: ID!, $product: ProductUpdateInput!) {
        productUpdate(id: $id, product: $product) {
          product { ${PRODUCT_FIELDS} }
          userErrors { code field message }
        }
      }`,
      { id, product: input },
    );
    this.failOnUserErrors('productUpdate', data.productUpdate.userErrors);
    if (!data.productUpdate.product) {
      throw new CmsApiError('productUpdate returned null', 500, 'null_product', 'shopify');
    }
    return data.productUpdate.product;
  }

  async deleteProduct(id: string): Promise<void> {
    const data = await this.gql<{
      productDelete: { deletedProductId: string | null; userErrors: UserError[] };
    }>(
      `mutation($id: ID!) {
        productDelete(input: { id: $id }) {
          deletedProductId
          userErrors { code field message }
        }
      }`,
      { id },
    );
    this.failOnUserErrors('productDelete', data.productDelete.userErrors);
  }
}
