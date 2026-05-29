import { ContentKind, RemotePost } from './cms/types.js';

export interface GhostSyncSettings {
  ghostUrl: string;
  adminApiKey: string;
  syncFolderPath: string;
  pullDrafts: boolean;
  pullPublished: boolean;
  conflictStrategy: 'ask' | 'keep_local' | 'keep_remote';
  /** How the watcher reacts to local file edits.
   *  - 'auto'   (default): push changes within the debounce window; periodic full sync.
   *  - 'manual': watcher only runs periodic pulls; pushes are user-driven via Sync Now /
   *    Push to Ghost. Lets cautious users avoid surprise writes to their blog. */
  syncMode: 'auto' | 'manual';
}

export const DEFAULT_SETTINGS: GhostSyncSettings = {
  ghostUrl: '',
  adminApiKey: '',
  syncFolderPath: 'ghost-posts',
  pullDrafts: true,
  pullPublished: true,
  conflictStrategy: 'ask',
  syncMode: 'auto',
};

export interface GhostPost {
  id: string;
  uuid: string;
  title: string;
  slug: string;
  html: string | null;
  mobiledoc: string | null;
  lexical: string | null;
  status: 'draft' | 'published' | 'scheduled';
  visibility: string;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  custom_excerpt: string | null;
  feature_image: string | null;
  featured: boolean;
  tags: GhostTag[];
  authors: GhostAuthor[];
  url: string;
}

export interface GhostTag {
  id: string;
  name: string;
  slug: string;
  description: string | null;
}

export interface GhostAuthor {
  id: string;
  name: string;
  slug: string;
  email: string;
}

export interface GhostPostsResponse {
  posts: GhostPost[];
  meta: {
    pagination: {
      page: number;
      limit: number;
      pages: number;
      total: number;
      next: number | null;
      prev: number | null;
    };
  };
}

export interface CreatePostData {
  title: string;
  mobiledoc?: string;
  lexical?: string;
  html?: string;
  status?: 'draft' | 'published' | 'scheduled';
  tags?: { name: string }[];
  feature_image?: string | null;
  custom_excerpt?: string | null;
  featured?: boolean;
}

export interface UpdatePostData extends Partial<CreatePostData> {
  id: string;
  updated_at: string;
}

export interface PostFrontmatter {
  /** Canonical v2 resource kind. Omitted/null means legacy `post`. */
  cms_kind?: ContentKind | null;
  ghost_id: string | null;
  ghost_slug: string | null;
  ghost_status: 'draft' | 'published' | 'scheduled';
  ghost_updated_at: string | null;
  local_updated_at: string | null;
  tags: string[];
  feature_image: string | null;
  excerpt: string | null;
}

export const DEFAULT_FRONTMATTER: PostFrontmatter = {
  cms_kind: null,
  ghost_id: null,
  ghost_slug: null,
  ghost_status: 'draft',
  ghost_updated_at: null,
  local_updated_at: null,
  tags: [],
  feature_image: null,
  excerpt: null,
};

/**
 * Vault file handle — replaces Obsidian's TFile.
 * Path is relative to the configured sync folder root.
 */
export interface VaultFile {
  /** Path relative to vault root, forward-slash separated. */
  path: string;
  /** Basename without extension. */
  basename: string;
  /** Last-modified time in epoch ms. */
  mtime: number;
}

export interface LocalPost {
  file: VaultFile;
  frontmatter: PostFrontmatter;
  title: string;
  content: string;
  rawContent: string;
}

export interface SyncResult {
  pulled: number;
  pushed: number;
  conflicts: ConflictItem[];
  errors: SyncError[];
}

/**
 * Result of a dry-run sync — describes what *would* happen without touching
 * disk or Ghost. Emitted as JSON by `ghost-sync sync --dry-run --json` and
 * surfaced by the Mac app's "Preview Sync" UI.
 */
export interface SyncPlan {
  direction: 'pull' | 'push' | 'sync';
  creates: PlanEntry[];
  updates: PlanEntry[];
  /** Local frontmatter-only writes that follow a Ghost create/update.
   *  Surfaced separately so the user isn't told they have "two updates per
   *  push" when one is just sync bookkeeping. */
  metadataUpdates: PlanEntry[];
  deletes: PlanEntry[];
  conflicts: PlanEntry[];
  skips: PlanEntry[];
  errors: PlanEntry[];
}

export interface PlanEntry {
  /** Whether the change would land in the local vault or on Ghost. */
  side: 'local' | 'remote';
  title: string;
  ghostId?: string;
  localPath?: string;
  details?: string;
}

export interface ConflictItem {
  localPost: LocalPost;
  /** Remote-side state of the conflict. Field name kept as `ghostPost`
   *  for back-compat with the Mac app's QueuedConflict JSON deserializer
   *  (PreviewSync.swift reads `ghostPost.title`). The VALUE is now a
   *  platform-agnostic RemotePost — Mac reads `.title` which both shapes
   *  carry. v0.5+ renames to `remotePost` once Mac is updated in lockstep. */
  ghostPost: RemotePost | null;
  type: 'both_modified' | 'deleted_remotely' | 'deleted_locally';
}

export interface SyncError {
  file?: string;
  ghostId?: string;
  message: string;
  recoverable: boolean;
}

export class GhostApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public errorType?: string,
  ) {
    super(message);
    this.name = 'GhostApiError';
  }

  isConflict(): boolean {
    return this.statusCode === 422 && this.message.includes('UPDATE_COLLISION');
  }

  isAuthError(): boolean {
    return this.statusCode === 401;
  }

  isNotFound(): boolean {
    return this.statusCode === 404;
  }
}
