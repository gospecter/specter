/**
 * Ghost Admin API client (Node fetch instead of Obsidian's requestUrl).
 */

import { getAuthHeaders } from './auth.js';
import {
  GhostPost,
  GhostPostsResponse,
  CreatePostData,
  UpdatePostData,
  GhostApiError,
} from '../types.js';

export interface GhostImage {
  url: string;
  ref?: string | null;
}

export interface GhostImageUploadInput {
  file: Blob;
  filename: string;
  ref?: string;
  purpose?: string;
}

export class GhostApiClient {
  private ghostUrl: string;
  private apiKey: string;

  constructor(ghostUrl: string, apiKey: string) {
    this.ghostUrl = ghostUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  private endpoint(path: string): string {
    return `${this.ghostUrl}/ghost/api/admin/${path}`;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    queryParams?: Record<string, string>,
  ): Promise<T> {
    const headers = await getAuthHeaders(this.apiKey);
    let url = this.endpoint(path);
    if (queryParams) {
      url += `?${new URLSearchParams(queryParams).toString()}`;
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 204) {
      return undefined as T;
    }

    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // Non-JSON response; keep raw text for error messaging.
      }
    }

    if (!res.ok) {
      const err = (parsed as { errors?: Array<{ message?: string; type?: string }> })?.errors?.[0];
      throw new GhostApiError(err?.message || text || `HTTP ${res.status}`, res.status, err?.type);
    }

    return parsed as T;
  }

  private async requestForm<T>(
    method: string,
    path: string,
    form: FormData,
  ): Promise<T> {
    const headers = await getAuthHeaders(this.apiKey);
    delete headers['Content-Type'];

    const res = await fetch(this.endpoint(path), {
      method,
      headers,
      body: form,
    });

    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // Non-JSON response; keep raw text for error messaging.
      }
    }

    if (!res.ok) {
      const err = (parsed as { errors?: Array<{ message?: string; type?: string }> })?.errors?.[0];
      throw new GhostApiError(err?.message || text || `HTTP ${res.status}`, res.status, err?.type);
    }

    return parsed as T;
  }

  async listPosts(options?: {
    status?: 'all' | 'draft' | 'published' | 'scheduled';
    limit?: number;
    page?: number;
    include?: string;
  }): Promise<GhostPostsResponse> {
    const queryParams: Record<string, string> = {
      include: options?.include || 'tags,authors',
      formats: 'html,mobiledoc,lexical',
      limit: String(options?.limit || 100),
      page: String(options?.page || 1),
    };
    if (options?.status && options.status !== 'all') {
      queryParams.filter = `status:${options.status}`;
    }
    return this.request<GhostPostsResponse>('GET', 'posts/', undefined, queryParams);
  }

  async listPages(options?: {
    status?: 'all' | 'draft' | 'published' | 'scheduled';
    limit?: number;
    page?: number;
    include?: string;
  }): Promise<GhostPostsResponse> {
    const queryParams: Record<string, string> = {
      include: options?.include || 'tags,authors',
      formats: 'html,mobiledoc,lexical',
      limit: String(options?.limit || 100),
      page: String(options?.page || 1),
    };
    if (options?.status && options.status !== 'all') {
      queryParams.filter = `status:${options.status}`;
    }
    const res = await this.request<{ pages: GhostPost[]; meta: GhostPostsResponse['meta'] }>(
      'GET',
      'pages/',
      undefined,
      queryParams,
    );
    return { posts: res.pages, meta: res.meta };
  }

  async fetchAllPosts(options?: {
    includeDrafts?: boolean;
    includePublished?: boolean;
  }): Promise<GhostPost[]> {
    const all: GhostPost[] = [];
    let page = 1;
    let hasMore = true;

    const statuses: string[] = [];
    if (options?.includePublished !== false) statuses.push('published');
    if (options?.includeDrafts !== false) statuses.push('draft');

    while (hasMore) {
      const queryParams: Record<string, string> = {
        include: 'tags,authors',
        formats: 'html,mobiledoc,lexical',
        limit: '100',
        page: String(page),
      };
      if (statuses.length > 0 && statuses.length < 3) {
        queryParams.filter = statuses.map((s) => `status:${s}`).join(',');
      }

      const res = await this.request<GhostPostsResponse>('GET', 'posts/', undefined, queryParams);
      all.push(...res.posts);
      hasMore = res.meta.pagination.next !== null;
      page++;
    }

    return all;
  }

  async fetchAllPages(options?: {
    includeDrafts?: boolean;
    includePublished?: boolean;
  }): Promise<GhostPost[]> {
    const all: GhostPost[] = [];
    let page = 1;
    let hasMore = true;

    const statuses: string[] = [];
    if (options?.includePublished !== false) statuses.push('published');
    if (options?.includeDrafts !== false) statuses.push('draft');

    while (hasMore) {
      const queryParams: Record<string, string> = {
        include: 'tags,authors',
        formats: 'html,mobiledoc,lexical',
        limit: '100',
        page: String(page),
      };
      if (statuses.length > 0 && statuses.length < 3) {
        queryParams.filter = statuses.map((s) => `status:${s}`).join(',');
      }

      const res = await this.request<{ pages: GhostPost[]; meta: GhostPostsResponse['meta'] }>(
        'GET',
        'pages/',
        undefined,
        queryParams,
      );
      all.push(...res.pages);
      hasMore = res.meta.pagination.next !== null;
      page++;
    }

    return all;
  }

  async getPost(id: string): Promise<GhostPost> {
    const res = await this.request<{ posts: GhostPost[] }>(
      'GET',
      `posts/${id}/`,
      undefined,
      { include: 'tags,authors', formats: 'html,mobiledoc,lexical' },
    );
    if (!res.posts?.length) {
      throw new GhostApiError('Post not found', 404);
    }
    return res.posts[0];
  }

  async getPage(id: string): Promise<GhostPost> {
    const res = await this.request<{ pages: GhostPost[] }>(
      'GET',
      `pages/${id}/`,
      undefined,
      { include: 'tags,authors', formats: 'html,mobiledoc,lexical' },
    );
    if (!res.pages?.length) {
      throw new GhostApiError('Page not found', 404);
    }
    return res.pages[0];
  }

  async getPostBySlug(slug: string): Promise<GhostPost> {
    const res = await this.request<{ posts: GhostPost[] }>(
      'GET',
      `posts/slug/${slug}/`,
      undefined,
      { include: 'tags,authors', formats: 'html,mobiledoc,lexical' },
    );
    if (!res.posts?.length) {
      throw new GhostApiError('Post not found', 404);
    }
    return res.posts[0];
  }

  async createPost(data: CreatePostData): Promise<GhostPost> {
    const res = await this.request<{ posts: GhostPost[] }>('POST', 'posts/', { posts: [data] });
    return res.posts[0];
  }

  async createPage(data: CreatePostData): Promise<GhostPost> {
    const res = await this.request<{ pages: GhostPost[] }>('POST', 'pages/', { pages: [data] });
    return res.pages[0];
  }

  async updatePost(data: UpdatePostData): Promise<GhostPost> {
    const { id, ...updateData } = data;
    const res = await this.request<{ posts: GhostPost[] }>('PUT', `posts/${id}/`, {
      posts: [updateData],
    });
    return res.posts[0];
  }

  async updatePage(data: UpdatePostData): Promise<GhostPost> {
    const { id, ...updateData } = data;
    const res = await this.request<{ pages: GhostPost[] }>('PUT', `pages/${id}/`, {
      pages: [updateData],
    });
    return res.pages[0];
  }

  async deletePost(id: string): Promise<void> {
    await this.request<void>('DELETE', `posts/${id}/`);
  }

  async deletePage(id: string): Promise<void> {
    await this.request<void>('DELETE', `pages/${id}/`);
  }

  async uploadImage(input: GhostImageUploadInput): Promise<GhostImage> {
    const form = new FormData();
    form.set('file', input.file, input.filename);
    if (input.ref) form.set('ref', input.ref);
    if (input.purpose) form.set('purpose', input.purpose);

    const res = await this.requestForm<{ images: GhostImage[] }>(
      'POST',
      'images/upload/',
      form,
    );
    if (!res.images?.[0]?.url) {
      throw new GhostApiError('Ghost image upload returned no image URL', 502, 'empty_image');
    }
    return res.images[0];
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      await this.listPosts({ limit: 1 });
      return { success: true, message: 'Successfully connected to Ghost API' };
    } catch (error) {
      if (error instanceof GhostApiError) {
        if (error.isAuthError()) {
          return { success: false, message: 'Authentication failed. Check your API key.' };
        }
        return { success: false, message: `API error: ${error.message}` };
      }
      return { success: false, message: `Connection failed: ${error}` };
    }
  }
}

export function markdownToMobiledoc(markdown: string): string {
  return JSON.stringify({
    version: '0.3.1',
    markups: [],
    atoms: [],
    cards: [['markdown', { markdown }]],
    sections: [[10, 0]],
  });
}

export function markdownToLexical(markdown: string): string {
  return JSON.stringify({
    root: {
      children: [{ type: 'markdown', version: 1, markdown }],
      direction: 'ltr',
      format: '',
      indent: 0,
      type: 'root',
      version: 1,
    },
  });
}

export function mobiledocToMarkdown(mobiledoc: string | null): string | null {
  if (!mobiledoc) return null;
  try {
    const doc = JSON.parse(mobiledoc);
    if (doc.cards && Array.isArray(doc.cards)) {
      for (const card of doc.cards) {
        if (card[0] === 'markdown' && card[1]?.markdown) {
          return card[1].markdown;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function lexicalToMarkdown(lexical: string | null): string | null {
  if (!lexical) return null;
  try {
    const doc = JSON.parse(lexical);
    if (doc.root?.children && Array.isArray(doc.root.children)) {
      for (const child of doc.root.children) {
        if (child.type === 'markdown' && child.markdown) {
          return child.markdown;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function postUsesLexical(post: { lexical: string | null; mobiledoc: string | null }): boolean {
  return !!post.lexical && !post.mobiledoc;
}
