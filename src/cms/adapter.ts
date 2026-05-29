/**
 * The CmsAdapter seam — every platform implements this surface.
 *
 * Engine code (pull / push / conflict / dryrun) talks to CmsAdapter, never
 * to a platform-specific client. The conversion layer per platform (the moat)
 * lives inside the adapter implementation; the engine stays platform-agnostic.
 *
 * Optimistic-lock semantics:
 *   - Ghost: requires the prior `updated_at` in the update payload, throws
 *     UPDATE_COLLISION on mismatch. Pass `baseVersion` to participate.
 *   - Shopify: no native optimistic lock; the adapter ignores `baseVersion`
 *     and the engine is expected to do read-then-write conflict detection.
 */

import {
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
} from './types.js';

export interface CmsAdapter {
  readonly platform: Platform;

  testConnection(): Promise<{ ok: boolean; message: string }>;

  listPosts(options?: ListOptions): Promise<RemotePost[]>;
  getPost(id: string): Promise<RemotePost>;

  createPost(input: CreatePostInput): Promise<RemotePost>;
  updatePost(
    id: string,
    input: UpdatePostInput,
    baseVersion?: { updatedAt: string },
  ): Promise<RemotePost>;
  deletePost(id: string): Promise<void>;

  /** Kind-aware content API. Adapters keep the post-specific methods above as
   *  compatibility aliases while the sync engine migrates. */
  listContent?(options?: ListOptions): Promise<RemoteContentItem[]>;
  getContent?(kind: ContentKind, id: string): Promise<RemoteContentItem>;
  createContent?(input: CreateContentInput): Promise<RemoteContentItem>;
  updateContent?(
    kind: ContentKind,
    id: string,
    input: UpdateContentInput,
    baseVersion?: { updatedAt: string },
  ): Promise<RemoteContentItem>;
  deleteContent?(kind: ContentKind, id: string): Promise<void>;
  uploadMedia?(input: UploadMediaInput): Promise<RemoteMediaRef>;

  /** Available containers (Shopify blogs). Flat platforms return a single
   *  synthetic container or an empty list. */
  listContainers(): Promise<RemoteContainer[]>;
}
