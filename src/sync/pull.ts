import {
  PostFrontmatter,
  LocalPost,
  ConflictItem,
  GhostSyncSettings,
  VaultFile,
} from '../types.js';
import { CmsAdapter } from '../cms/adapter.js';
import { RemoteContentItem, RemotePost } from '../cms/types.js';
import {
  serializePostContent,
  titleToFilename,
  hasLocalChanges,
  isGhostNewer,
} from '../utils/frontmatter.js';
import { Vault, normalizePath } from '../vault.js';

export interface PullResult {
  created: string[];
  updated: string[];
  skipped: string[];
  conflicts: ConflictItem[];
  errors: { post: RemotePost; error: string }[];
}

export async function pullFromGhost(
  vault: Vault,
  adapter: CmsAdapter,
  settings: GhostSyncSettings,
  existingPosts: Map<string, LocalPost>,
): Promise<PullResult> {
  const result: PullResult = {
    created: [],
    updated: [],
    skipped: [],
    conflicts: [],
    errors: [],
  };

  const remotePosts = adapter.listContent
    ? await adapter.listContent({
        includeDrafts: settings.pullDrafts,
        includePublished: settings.pullPublished,
      })
    : await adapter.listPosts({
        includeDrafts: settings.pullDrafts,
        includePublished: settings.pullPublished,
      });

  await vault.ensureFolder(settings.syncFolderPath);

  for (const remotePost of remotePosts) {
    try {
      await processRemotePost(vault, adapter, remotePost, settings, existingPosts, result);
    } catch (error) {
      result.errors.push({
        post: remotePost,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

async function processRemotePost(
  vault: Vault,
  adapter: CmsAdapter,
  remotePost: RemotePost,
  settings: GhostSyncSettings,
  existingPosts: Map<string, LocalPost>,
  result: PullResult,
): Promise<void> {
  const existing = existingPosts.get(remotePost.id);
  const existingByKind = existingPosts.get(remoteIdentityKey(remotePost));

  if (!existing && !existingByKind) {
    await createLocalPost(vault, remotePost, settings, adapter.platform);
    result.created.push(remotePost.title);
    return;
  }

  const localPost = existingByKind ?? existing;
  if (!localPost) return;

  if (!isGhostNewer(remotePost.updatedAt, localPost.frontmatter.ghost_updated_at)) {
    result.skipped.push(remotePost.title);
    return;
  }

  const localHasChanges = hasLocalChanges(localPost.file.mtime, localPost.frontmatter);

  if (localHasChanges && settings.conflictStrategy === 'ask') {
    result.conflicts.push({ localPost, ghostPost: remotePost, type: 'both_modified' });
    return;
  }
  if (localHasChanges && settings.conflictStrategy === 'keep_local') {
    result.skipped.push(remotePost.title);
    return;
  }

  await updateLocalPost(vault, localPost.file, remotePost, adapter.platform);
  result.updated.push(remotePost.title);
}

async function createLocalPost(
  vault: Vault,
  remotePost: RemotePost,
  settings: GhostSyncSettings,
  platform: CmsAdapter['platform'],
): Promise<VaultFile> {
  const content = remotePost.body;
  const frontmatter = remotePostToFrontmatter(remotePost);
  const fileContent = serializePostContent(frontmatter, remotePost.title, content, {
    platform,
    kind: remotePost.kind ?? 'post',
  });
  const filename = titleToFilename(remotePost.title || remotePost.slug);
  const basePath = normalizePath(`${settings.syncFolderPath}/${filename}.md`);
  const uniquePath = await uniqueFilePath(vault, basePath);
  return vault.create(uniquePath, fileContent);
}

async function updateLocalPost(
  vault: Vault,
  file: VaultFile,
  remotePost: RemotePost,
  platform: CmsAdapter['platform'],
): Promise<void> {
  const content = remotePost.body;
  const frontmatter = remotePostToFrontmatter(remotePost);
  const fileContent = serializePostContent(frontmatter, remotePost.title, content, {
    platform,
    kind: remotePost.kind ?? 'post',
  });
  await vault.write(file, fileContent);
}

/** Map a RemotePost to the legacy v1 PostFrontmatter shape currently written
 *  to disk. v0.4.0 still writes the legacy shape (dual-write starts in this
 *  release per the synthesis sequence); v0.5+ may add a `cms` block. */
export function remotePostToFrontmatter(remotePost: RemotePost): PostFrontmatter {
  return {
    cms_kind: remotePost.kind ?? 'post',
    ghost_id: remotePost.id,
    ghost_slug: remotePost.slug,
    ghost_status: remotePost.status,
    ghost_updated_at: remotePost.updatedAt,
    local_updated_at: new Date().toISOString(),
    tags: remotePost.tags,
    feature_image: remotePost.featureImage,
    excerpt: remotePost.summary,
  };
}

function remoteIdentityKey(remotePost: RemotePost | RemoteContentItem): string {
  return `${remotePost.kind ?? 'post'}:${remotePost.id}`;
}

async function uniqueFilePath(vault: Vault, basePath: string): Promise<string> {
  let p = basePath;
  let counter = 1;
  while (await vault.exists(p)) {
    const ext = basePath.lastIndexOf('.');
    p = ext > 0 ? `${basePath.slice(0, ext)}-${counter}${basePath.slice(ext)}` : `${basePath}-${counter}`;
    counter++;
  }
  return p;
}
