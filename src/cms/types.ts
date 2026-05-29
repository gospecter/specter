/**
 * Platform-agnostic types for the CMS adapter seam.
 *
 * `RemotePost` is the canonical shape the sync engine sees, regardless of
 * which CMS produced it. Each adapter (Ghost, Shopify, …) maps its native
 * shape to/from this.
 *
 * Body is always stored as markdown in `RemotePost` — adapters do the
 * HTML↔markdown conversion at the seam. This is what lets the rest of the
 * engine stay platform-agnostic.
 */

export type Platform = 'ghost' | 'shopify' | 'wordpress';

export type PostStatus = 'draft' | 'published' | 'scheduled';

export type ContentKind =
  | 'post'
  | 'page'
  | 'article'
  | 'product'
  | `wordpress:${string}`;

/**
 * Optional "container" the post lives in. Shopify articles belong to a
 * `Blog`; Ghost posts live in a single flat namespace and report `null`.
 * Drives folder layout: `<container.handle>/<slug>.md` when present,
 * `<slug>.md` when null.
 */
export interface RemoteContainer {
  /** Native identifier (Shopify gid; Ghost: not applicable). */
  id: string;
  /** URL-safe identifier — drives folder name. */
  handle: string;
  /** Human-readable label. */
  title: string;
}

export interface RemotePost {
  /** Platform resource kind. Defaults to `post` for older adapters/files. */
  kind?: ContentKind;
  /** Native ID — opaque to the engine. */
  id: string;
  /** URL-safe slug (Shopify calls it `handle`). */
  slug: string;
  title: string;
  /** Body as markdown. Adapters convert from the platform-native format. */
  body: string;
  status: PostStatus;
  tags: string[];
  /** Short summary / excerpt. */
  summary: string | null;
  /** URL of the feature/header image, or null. */
  featureImage: string | null;
  /** Author name as a string — adapters flatten complex author models. */
  author: string | null;
  /** ISO 8601. Used for optimistic-lock checks where the platform supports it. */
  updatedAt: string;
  createdAt: string;
  publishedAt: string | null;
  /** Multi-container platforms (Shopify) set this; flat platforms (Ghost) leave null. */
  container: RemoteContainer | null;
  /** Public URL, or null if not published. */
  url: string | null;
}

/**
 * Input for creating a new post. `body` is markdown; the adapter converts
 * to the platform-native format.
 */
export interface CreatePostInput {
  /** Platform resource kind to create. Defaults to `post` for compatibility. */
  kind?: ContentKind;
  title: string;
  slug?: string;
  body: string;
  status?: PostStatus;
  tags?: string[];
  summary?: string | null;
  featureImage?: string | null;
  author?: string | null;
  /** For multi-container platforms — which container to create in.
   *  If omitted, the adapter chooses (typically the first / default). */
  containerHandle?: string;
}

export interface UpdatePostInput {
  /** Platform resource kind. Defaults to `post` for compatibility. */
  kind?: ContentKind;
  title?: string;
  slug?: string;
  body?: string;
  status?: PostStatus;
  tags?: string[];
  summary?: string | null;
  featureImage?: string | null;
  author?: string | null;
  /** Move to a different container (Shopify only — Ghost adapter ignores). */
  containerHandle?: string;
}

export interface ListOptions {
  includeDrafts?: boolean;
  includePublished?: boolean;
  /** Resource kinds to include. Omitted means adapter default, currently posts. */
  kinds?: ContentKind[];
}

export type RemoteContentItem = RemotePost & { kind: ContentKind };
export type CreateContentInput = CreatePostInput & { kind: ContentKind };
export type UpdateContentInput = UpdatePostInput;

export interface RemoteMediaRef {
  id?: string;
  url: string;
  alt?: string | null;
  filename?: string;
  mimeType?: string;
  platform: Platform;
}

export interface UploadMediaInput {
  file: Blob;
  filename: string;
  mimeType?: string;
  alt?: string | null;
  ref?: string;
  purpose?: 'image' | 'profile_image' | 'icon' | string;
}

/**
 * Per-platform credential block. Discriminated by `platform`.
 * Other config (vault path, sync folder, conflict strategy, …) stays in the
 * top-level DaemonConfig — these fields are purely the CMS connection.
 */
export type AdapterConfig =
  | {
      platform: 'ghost';
      ghostUrl: string;
      adminApiKey: string;
    }
  | {
      platform: 'shopify';
      /** Full myshopify.com domain, e.g. "my-store.myshopify.com". */
      shop: string;
      /** Admin API access token (shpat_… for dev-store, OAuth token in prod). */
      accessToken: string;
      /** OAuth refresh token for expiring offline tokens. Rotated after every refresh. */
      refreshToken?: string;
      /** ISO timestamp when the access token expires. */
      accessTokenExpiresAt?: string;
      /** ISO timestamp when the refresh token expires. */
      refreshTokenExpiresAt?: string;
      /** GraphQL API version. Defaults to the adapter's pinned version. */
      apiVersion?: string;
    }
  | {
      platform: 'wordpress';
      /** Full URL of the WordPress site, e.g. "https://myblog.com". */
      siteUrl: string;
      /** WordPress username. */
      username: string;
      /** Application Password — 24-char string (spaces stripped internally). */
      appPassword: string;
    };

export class CmsApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public errorType?: string,
    public platform?: Platform,
    /** Adapter-supplied retry hint in ms — set by rate-limit mappers when
     *  the platform exposes a restore rate or Retry-After header. */
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'CmsApiError';
  }

  /** Adapters set errorType='conflict' explicitly. Engine code branches on this
   *  to decide read-then-write retry vs. surface-to-user. */
  isConflict(): boolean {
    return this.errorType === 'conflict';
  }
  isAuthError(): boolean {
    return this.statusCode === 401 || this.statusCode === 403;
  }
  isNotFound(): boolean {
    return this.statusCode === 404 || this.errorType === 'not_found';
  }
  isRateLimited(): boolean {
    return this.errorType === 'rate_limited' || this.statusCode === 429 || this.statusCode === 430;
  }
}
