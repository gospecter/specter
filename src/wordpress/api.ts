import { CmsApiError, type Platform } from '../cms/types.js';

export interface WpPost {
  id: number;
  slug: string;
  title: { rendered: string };
  content: { rendered: string };
  excerpt: { rendered: string };
  status: 'publish' | 'draft' | 'private' | 'future' | 'pending';
  tags: number[];
  categories: number[];
  featured_media: number;
  author: number;
  date: string;
  date_gmt: string;
  modified: string;
  modified_gmt: string;
  link: string | null;
}

export interface WpPostInput {
  title?: string;
  content?: string;
  excerpt?: string;
  status?: string;
  slug?: string;
  tags?: number[];
  categories?: number[];
  featured_media?: number;
}

export interface WpCategory {
  id: number;
  slug: string;
  name: string;
}

export interface WpTag {
  id: number;
  slug: string;
  name: string;
}

export interface WpMedia {
  id: number;
  source_url: string;
}

export interface WpMediaUploadInput {
  file: Blob;
  filename: string;
  mimeType?: string;
  alt?: string | null;
}

const WP_PLATFORM: Platform = 'wordpress';
const MAX_AUTO_PAGES = 50;

function parseRetryAfter(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const asInt = Number(raw);
  if (Number.isFinite(asInt)) return Math.max(0, asInt * 1000);
  const asDate = Date.parse(raw);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return undefined;
}

function normalizeBaseUrl(siteUrl: string): string {
  let url = siteUrl.trim().replace(/\/$/, '');
  if (url.includes('/wp-json/wp/v2')) {
    url = url.replace(/\/wp-json\/wp\/v2.*$/, '');
  } else if (url.includes('/wp-json')) {
    url = url.replace(/\/wp-json.*$/, '');
  }
  return `${url}/wp-json/wp/v2`;
}

function isHtmlBody(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('<!DOCTYPE') || t.startsWith('<!doctype') || t.startsWith('<html');
}

function buildAuthHeader(username: string, appPassword: string): string {
  const stripped = appPassword.replace(/\s+/g, '');
  return `Basic ${btoa(`${username}:${stripped}`)}`;
}

export class WordPressApiClient {
  private baseUrl: string;
  private authHeader: string;

  constructor(siteUrl: string, username: string, appPassword: string) {
    this.baseUrl = normalizeBaseUrl(siteUrl);
    this.authHeader = buildAuthHeader(username, appPassword);
  }

  private async fetch<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number>,
  ): Promise<{ data: T; headers: Headers }> {
    let url = `${this.baseUrl}${path}`;
    if (query && Object.keys(query).length > 0) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        params.set(k, String(v));
      }
      url += `?${params.toString()}`;
    }

    const res = await globalThis.fetch(url, {
      method,
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.status === 204) {
      return { data: undefined as T, headers: res.headers };
    }

    const text = await res.text();

    if (!res.ok) {
      if (isHtmlBody(text)) {
        throw new CmsApiError(
          'WordPress returned HTML instead of JSON — a security plugin may be blocking REST API access. Check Wordfence / iThemes Security settings or contact your host.',
          res.status,
          res.status === 401 || res.status === 403 ? 'auth' : undefined,
          WP_PLATFORM,
        );
      }

      if (res.status === 401 || res.status === 403) {
        const parsed = tryParseJson<{ message?: string }>(text);
        throw new CmsApiError(
          parsed?.message ?? `WordPress auth failed (HTTP ${res.status})`,
          res.status,
          'auth',
          WP_PLATFORM,
        );
      }

      if (res.status === 404) {
        const parsed = tryParseJson<{ message?: string }>(text);
        throw new CmsApiError(
          parsed?.message ?? `WordPress resource not found (HTTP 404)`,
          404,
          'not_found',
          WP_PLATFORM,
        );
      }

      if (res.status === 429) {
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
        const parsed = tryParseJson<{ message?: string }>(text);
        throw new CmsApiError(
          parsed?.message ?? `WordPress rate-limited (HTTP 429)`,
          429,
          'rate_limited',
          WP_PLATFORM,
          retryAfter,
        );
      }

      if (res.status === 409) {
        const parsed = tryParseJson<{ message?: string; code?: string }>(text);
        throw new CmsApiError(
          parsed?.message ?? `WordPress conflict (HTTP 409)`,
          409,
          'conflict',
          WP_PLATFORM,
        );
      }

      const parsed = tryParseJson<{ message?: string }>(text);
      throw new CmsApiError(
        parsed?.message ?? `WordPress API error (HTTP ${res.status})`,
        res.status,
        undefined,
        WP_PLATFORM,
      );
    }

    let data: T;
    try {
      data = JSON.parse(text) as T;
    } catch {
      throw new CmsApiError(
        `WordPress returned non-JSON: ${text.slice(0, 200)}`,
        res.status,
        'parse',
        WP_PLATFORM,
      );
    }

    return { data, headers: res.headers };
  }

  private async fetchRaw<T>(
    method: string,
    path: string,
    body: BodyInit,
    headers: Record<string, string>,
  ): Promise<{ data: T; headers: Headers }> {
    const res = await globalThis.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: this.authHeader,
        Accept: 'application/json',
        ...headers,
      },
      body,
    });

    const text = await res.text();
    if (!res.ok) {
      const parsed = tryParseJson<{ message?: string }>(text);
      throw new CmsApiError(
        parsed?.message ?? `WordPress API error (HTTP ${res.status})`,
        res.status,
        res.status === 401 || res.status === 403 ? 'auth' : undefined,
        WP_PLATFORM,
      );
    }

    try {
      return { data: JSON.parse(text) as T, headers: res.headers };
    } catch {
      throw new CmsApiError(
        `WordPress returned non-JSON: ${text.slice(0, 200)}`,
        res.status,
        'parse',
        WP_PLATFORM,
      );
    }
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      const meUrl = `${this.baseUrl}/users/me`;
      const res = await globalThis.fetch(meUrl, {
        headers: { Authorization: this.authHeader, Accept: 'application/json' },
      });

      if (res.status === 401 || res.status === 403) {
        return { ok: false, message: 'Authentication failed — check username and Application Password.' };
      }

      if (res.status === 404) {
        return {
          ok: false,
          message: `Could not find the WordPress REST API at ${this.baseUrl.replace(/\/wp\/v2$/, '')}. Ensure pretty permalinks are enabled in WP Settings → Permalinks.`,
        };
      }

      if (!res.ok) {
        const text = await res.text();
        if (isHtmlBody(text)) {
          return { ok: false, message: 'WordPress returned HTML instead of JSON — a security plugin may be blocking REST API access.' };
        }
        return { ok: false, message: `WordPress API error (HTTP ${res.status})` };
      }

      const user = (await res.json()) as { name?: string };
      return { ok: true, message: `Connected as ${user.name ?? 'unknown user'}` };
    } catch (err) {
      if (err instanceof CmsApiError) return { ok: false, message: err.message };
      return { ok: false, message: `Connection failed: ${String(err)}` };
    }
  }

  async fetchPosts(options?: {
    status?: string;
    page?: number;
    perPage?: number;
  }): Promise<WpPost[]> {
    return this.fetchPostType('/posts', options);
  }

  async fetchPages(options?: {
    status?: string;
    page?: number;
    perPage?: number;
  }): Promise<WpPost[]> {
    return this.fetchPostType('/pages', options);
  }

  private async fetchPostType(path: '/posts' | '/pages', options?: {
    status?: string;
    page?: number;
    perPage?: number;
  }): Promise<WpPost[]> {
    const perPage = options?.perPage ?? 100;
    const status = options?.status ?? 'any';

    if (options?.page !== undefined) {
      const { data } = await this.fetch<WpPost[]>('GET', path, undefined, {
        status,
        page: options.page,
        per_page: perPage,
      });
      return data;
    }

    const all: WpPost[] = [];
    let currentPage = 1;
    let totalPages = 1;

    while (currentPage <= totalPages && currentPage <= MAX_AUTO_PAGES) {
      const { data, headers } = await this.fetch<WpPost[]>('GET', path, undefined, {
        status,
        page: currentPage,
        per_page: perPage,
      });
      all.push(...data);

      if (currentPage === 1) {
        const h = headers.get('X-WP-TotalPages');
        totalPages = h ? parseInt(h, 10) : 1;
        if (!Number.isFinite(totalPages) || totalPages < 1) totalPages = 1;
      }

      currentPage++;
    }

    return all;
  }

  async getPost(id: number): Promise<WpPost> {
    const { data } = await this.fetch<WpPost>('GET', `/posts/${id}`);
    return data;
  }

  async getPage(id: number): Promise<WpPost> {
    const { data } = await this.fetch<WpPost>('GET', `/pages/${id}`);
    return data;
  }

  async createPost(input: WpPostInput): Promise<WpPost> {
    const { data } = await this.fetch<WpPost>('POST', '/posts', input);
    return data;
  }

  async createPage(input: WpPostInput): Promise<WpPost> {
    const { data } = await this.fetch<WpPost>('POST', '/pages', input);
    return data;
  }

  async updatePost(id: number, input: WpPostInput): Promise<WpPost> {
    const { data } = await this.fetch<WpPost>('POST', `/posts/${id}`, input);
    return data;
  }

  async updatePage(id: number, input: WpPostInput): Promise<WpPost> {
    const { data } = await this.fetch<WpPost>('POST', `/pages/${id}`, input);
    return data;
  }

  async deletePost(id: number): Promise<void> {
    await this.fetch<unknown>('DELETE', `/posts/${id}`, undefined, { force: 'true' });
  }

  async deletePage(id: number): Promise<void> {
    await this.fetch<unknown>('DELETE', `/pages/${id}`, undefined, { force: 'true' });
  }

  async getMedia(id: number): Promise<WpMedia> {
    const { data } = await this.fetch<WpMedia>('GET', `/media/${id}`);
    return data;
  }

  async uploadMedia(input: WpMediaUploadInput): Promise<WpMedia> {
    const { data } = await this.fetchRaw<WpMedia>(
      'POST',
      '/media',
      input.file,
      {
        'Content-Disposition': `attachment; filename="${input.filename.replace(/"/g, '')}"`,
        'Content-Type': input.mimeType ?? (input.file.type || 'application/octet-stream'),
      },
    );
    return data;
  }

  async listCategories(): Promise<WpCategory[]> {
    return this.fetchAllPages<WpCategory>('/categories');
  }

  async listTags(): Promise<WpTag[]> {
    return this.fetchAllPages<WpTag>('/tags');
  }

  async createTag(name: string): Promise<WpTag> {
    const { data } = await this.fetch<WpTag>('POST', '/tags', { name });
    return data;
  }

  async createCategory(name: string): Promise<WpCategory> {
    const { data } = await this.fetch<WpCategory>('POST', '/categories', { name });
    return data;
  }

  private async fetchAllPages<T>(path: string): Promise<T[]> {
    const all: T[] = [];
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages) {
      const { data, headers } = await this.fetch<T[]>('GET', path, undefined, {
        per_page: 100,
        page,
      });
      all.push(...data);
      if (page === 1) {
        const h = headers.get('X-WP-TotalPages');
        totalPages = h ? parseInt(h, 10) : 1;
        if (!Number.isFinite(totalPages) || totalPages < 1) totalPages = 1;
      }
      page++;
    }

    return all;
  }
}

function tryParseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
