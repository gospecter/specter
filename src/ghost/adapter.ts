/**
 * Ghost implementation of CmsAdapter.
 *
 * Wraps the existing GhostApiClient — does not modify it. Translates
 * GhostPost ↔ RemotePost at the seam.
 *
 * Optimistic lock: Ghost requires the prior `updated_at` in updates and
 * throws `UPDATE_COLLISION` (422) on mismatch. `updatePost` honors
 * `baseVersion.updatedAt`; if omitted, it does a getPost first to fetch
 * the current version (slower; engine code should pass baseVersion).
 *
 * Content format: Ghost prefers Lexical (current) over mobiledoc (legacy).
 * On pull, we read whichever the post carries (lexical → mobiledoc → html
 * fallback via turndown). On push, we wrap markdown in Lexical.
 */

import { CmsAdapter } from '../cms/adapter.js';
import {
  CmsApiError,
  ContentKind,
  CreateContentInput,
  CreatePostInput,
  ListOptions,
  Platform,
  PostStatus,
  RemoteContentItem,
  RemoteContainer,
  RemoteMediaRef,
  RemotePost,
  UpdateContentInput,
  UpdatePostInput,
  UploadMediaInput,
} from '../cms/types.js';
import { GhostApiError, GhostPost } from '../types.js';
import { htmlToMarkdown } from '../utils/markdown.js';
import {
  GhostApiClient,
  lexicalToMarkdown,
  markdownToLexical,
  markdownToMobiledoc,
  mobiledocToMarkdown,
  postUsesLexical,
} from './api.js';

export class GhostAdapter implements CmsAdapter {
  readonly platform: Platform = 'ghost';

  constructor(private api: GhostApiClient) {}

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    const r = await this.api.testConnection();
    return { ok: r.success, message: r.message };
  }

  async listPosts(options?: ListOptions): Promise<RemotePost[]> {
    return this.translate(async () => {
      const posts = await this.api.fetchAllPosts({
        includeDrafts: options?.includeDrafts,
        includePublished: options?.includePublished,
      });
      return posts.map((post) => ghostPostToRemotePost(post, 'post'));
    });
  }

  async getPost(id: string): Promise<RemotePost> {
    return this.translate(async () => ghostPostToRemotePost(await this.api.getPost(id), 'post'));
  }

  async createPost(input: CreatePostInput): Promise<RemotePost> {
    return this.translate(async () => {
      const lexical = markdownToLexical(input.body);
      const post = await this.api.createPost({
        title: input.title,
        lexical,
        status: input.status ?? 'draft',
        tags: input.tags?.map((name) => ({ name })),
        feature_image: input.featureImage ?? null,
        custom_excerpt: input.summary ?? null,
      });
      return ghostPostToRemotePost(post, 'post');
    });
  }

  async updatePost(
    id: string,
    input: UpdatePostInput,
    baseVersion?: { updatedAt: string },
  ): Promise<RemotePost> {
    return this.translate(async () => {
      // Need to know the existing content format (lexical vs mobiledoc) before
      // writing — one getPost either way. baseVersion overrides updatedAt if
      // supplied (lets the engine pass a known-stale version to force a
      // conflict for explicit detection paths).
      const current = await this.api.getPost(id);
      const updatedAt = baseVersion?.updatedAt ?? current.updated_at;
      const useLexical = postUsesLexical(current);

      const contentField =
        input.body !== undefined
          ? useLexical
            ? { lexical: markdownToLexical(input.body) }
            : { mobiledoc: markdownToMobiledoc(input.body) }
          : {};

      const post = await this.api.updatePost({
        id,
        updated_at: updatedAt,
        title: input.title,
        ...contentField,
        status: input.status,
        tags: input.tags?.map((name) => ({ name })),
        feature_image: input.featureImage ?? undefined,
        custom_excerpt: input.summary ?? undefined,
      });
      return ghostPostToRemotePost(post, 'post');
    });
  }

  async deletePost(id: string): Promise<void> {
    return this.translate(async () => {
      await this.api.deletePost(id);
    });
  }

  async listContainers(): Promise<RemoteContainer[]> {
    // Ghost has no multi-container concept; return an empty list.
    return [];
  }

  async listContent(options?: ListOptions): Promise<RemoteContentItem[]> {
    return this.translate(async () => {
      const kinds = options?.kinds ?? ['post', 'page'];
      const batches: Promise<RemoteContentItem[]>[] = [];
      if (kinds.includes('post')) {
        batches.push(
          this.api
            .fetchAllPosts({
              includeDrafts: options?.includeDrafts,
              includePublished: options?.includePublished,
            })
            .then((posts) => posts.map((post) => ghostPostToRemotePost(post, 'post'))),
        );
      }
      if (kinds.includes('page')) {
        batches.push(
          this.api
            .fetchAllPages({
              includeDrafts: options?.includeDrafts,
              includePublished: options?.includePublished,
            })
            .then((pages) => pages.map((page) => ghostPostToRemotePost(page, 'page'))),
        );
      }
      return (await Promise.all(batches)).flat();
    });
  }

  async getContent(kind: ContentKind, id: string): Promise<RemoteContentItem> {
    return this.translate(async () => {
      if (kind === 'post') return ghostPostToRemotePost(await this.api.getPost(id), 'post');
      if (kind === 'page') return ghostPostToRemotePost(await this.api.getPage(id), 'page');
      throw new CmsApiError(
        `Ghost content kind "${kind}" is not supported`,
        400,
        'unsupported_kind',
        'ghost',
      );
    });
  }

  async createContent(input: CreateContentInput): Promise<RemoteContentItem> {
    return this.translate(async () => {
      if (input.kind === 'post') return this.createPost(input) as Promise<RemoteContentItem>;
      if (input.kind !== 'page') {
        throw new CmsApiError(
          `Ghost content kind "${input.kind}" is not supported`,
          400,
          'unsupported_kind',
          'ghost',
        );
      }
      const page = await this.api.createPage({
        title: input.title,
        lexical: markdownToLexical(input.body),
        status: input.status ?? 'draft',
        tags: input.tags?.map((name) => ({ name })),
        feature_image: input.featureImage ?? null,
        custom_excerpt: input.summary ?? null,
      });
      return ghostPostToRemotePost(page, 'page');
    });
  }

  async updateContent(
    kind: ContentKind,
    id: string,
    input: UpdateContentInput,
    baseVersion?: { updatedAt: string },
  ): Promise<RemoteContentItem> {
    return this.translate(async () => {
      if (kind === 'post') {
        return this.updatePost(id, input, baseVersion) as Promise<RemoteContentItem>;
      }
      if (kind !== 'page') {
        throw new CmsApiError(
          `Ghost content kind "${kind}" is not supported`,
          400,
          'unsupported_kind',
          'ghost',
        );
      }
      const current = await this.api.getPage(id);
      const updatedAt = baseVersion?.updatedAt ?? current.updated_at;
      const useLexical = postUsesLexical(current);
      const contentField =
        input.body !== undefined
          ? useLexical
            ? { lexical: markdownToLexical(input.body) }
            : { mobiledoc: markdownToMobiledoc(input.body) }
          : {};

      const page = await this.api.updatePage({
        id,
        updated_at: updatedAt,
        title: input.title,
        ...contentField,
        status: input.status,
        tags: input.tags?.map((name) => ({ name })),
        feature_image: input.featureImage ?? undefined,
        custom_excerpt: input.summary ?? undefined,
      });
      return ghostPostToRemotePost(page, 'page');
    });
  }

  async deleteContent(kind: ContentKind, id: string): Promise<void> {
    return this.translate(async () => {
      if (kind === 'post') {
        await this.api.deletePost(id);
        return;
      }
      if (kind === 'page') {
        await this.api.deletePage(id);
        return;
      }
      throw new CmsApiError(
        `Ghost content kind "${kind}" is not supported`,
        400,
        'unsupported_kind',
        'ghost',
      );
    });
  }

  async uploadMedia(input: UploadMediaInput): Promise<RemoteMediaRef> {
    return this.translate(async () => {
      const image = await this.api.uploadImage({
        file: input.file,
        filename: input.filename,
        ref: input.ref,
        purpose: input.purpose,
      });
      return {
        id: image.ref ?? undefined,
        url: image.url,
        alt: input.alt ?? null,
        filename: input.filename,
        mimeType: input.mimeType,
        platform: 'ghost',
      };
    });
  }

  /** Run an operation against the underlying Ghost client and translate any
   *  `GhostApiError` into the unified `CmsApiError` so engine code only ever
   *  pattern-matches one error shape. Preserves Ghost's `UPDATE_COLLISION`
   *  conflict semantics via `errorType: 'conflict'`. */
  private async translate<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof GhostApiError) {
        const errorType = err.isConflict() ? 'conflict' : err.errorType;
        throw new CmsApiError(err.message, err.statusCode, errorType, 'ghost');
      }
      throw err;
    }
  }
}

export function ghostPostToRemotePost(
  post: GhostPost,
  kind: ContentKind = 'post',
): RemoteContentItem {
  return {
    kind,
    id: post.id,
    slug: post.slug,
    title: post.title,
    body: ghostPostBodyToMarkdown(post),
    status: post.status as PostStatus,
    tags: post.tags?.map((t) => t.name) ?? [],
    summary: post.custom_excerpt ?? null,
    featureImage: post.feature_image ?? null,
    author: post.authors?.[0]?.name ?? null,
    updatedAt: post.updated_at,
    createdAt: post.created_at,
    publishedAt: post.published_at,
    container: null,
    url: post.url || null,
  };
}

function ghostPostBodyToMarkdown(post: GhostPost): string {
  const fromLexical = lexicalToMarkdown(post.lexical);
  if (fromLexical) return fromLexical;
  const fromMobiledoc = mobiledocToMarkdown(post.mobiledoc);
  if (fromMobiledoc) return fromMobiledoc;
  return htmlToMarkdown(post.html);
}
