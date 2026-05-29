import {
  LocalPost,
  ConflictItem,
  GhostSyncSettings,
  PostFrontmatter,
  VaultFile,
} from '../types.js';
import { CmsAdapter } from '../cms/adapter.js';
import { CmsApiError, ContentKind, RemotePost } from '../cms/types.js';
import { serializePostContent, hasLocalChanges } from '../utils/frontmatter.js';
import { cleanMarkdownForGhost } from '../utils/markdown.js';
import { Vault } from '../vault.js';
import { uploadLocalFeatureImage, uploadLocalMarkdownImages } from './assets.js';

export interface PushResult {
  created: string[];
  updated: string[];
  skipped: string[];
  /** Posts that would have been uploaded but were held back because the
   *  free-tier monthly cap was reached during this run. Empty on Pro. */
  deferred: string[];
  conflicts: ConflictItem[];
  errors: { file: VaultFile; error: string }[];
}

export async function pushToGhost(
  vault: Vault,
  adapter: CmsAdapter,
  settings: GhostSyncSettings,
  localPosts: LocalPost[],
  maxUploads?: number,
): Promise<PushResult> {
  const result: PushResult = {
    created: [],
    updated: [],
    skipped: [],
    deferred: [],
    conflicts: [],
    errors: [],
  };

  for (const localPost of localPosts) {
    try {
      await processLocalPost(vault, adapter, localPost, settings, result, maxUploads);
    } catch (error) {
      result.errors.push({
        file: localPost.file,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

export async function pushSinglePost(
  vault: Vault,
  adapter: CmsAdapter,
  localPost: LocalPost,
  settings: GhostSyncSettings,
): Promise<{ success: boolean; error?: string; conflict?: ConflictItem }> {
  const result: PushResult = {
    created: [],
    updated: [],
    skipped: [],
    deferred: [],
    conflicts: [],
    errors: [],
  };
  try {
    await processLocalPost(vault, adapter, localPost, settings, result);
    if (result.conflicts.length > 0) return { success: false, conflict: result.conflicts[0] };
    if (result.errors.length > 0) return { success: false, error: result.errors[0].error };
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function processLocalPost(
  vault: Vault,
  adapter: CmsAdapter,
  localPost: LocalPost,
  settings: GhostSyncSettings,
  result: PushResult,
  maxUploads?: number,
): Promise<void> {
  const { frontmatter, title, content, file } = localPost;

  const localModified = hasLocalChanges(file.mtime, frontmatter);
  if (!localModified && frontmatter.ghost_id) {
    result.skipped.push(title || file.basename);
    return;
  }

  // Free-tier cap: once we've hit `maxUploads` real uploads this run, defer
  // any further would-be uploads instead of refusing the whole batch.
  if (maxUploads !== undefined) {
    const used = result.created.length + result.updated.length;
    if (used >= maxUploads) {
      result.deferred.push(title || file.basename);
      return;
    }
  }

  if (!frontmatter.ghost_id) {
    await createRemotePost(vault, adapter, localPost, content, result);
  } else {
    await updateRemotePost(vault, adapter, localPost, content, settings, result);
  }
}

async function createRemotePost(
  vault: Vault,
  adapter: CmsAdapter,
  localPost: LocalPost,
  content: string,
  result: PushResult,
): Promise<void> {
  const { frontmatter, title, file } = localPost;
  const withUploadedImages = await uploadLocalMarkdownImages(vault, adapter, file, content);
  const cleanedContent = cleanMarkdownForGhost(withUploadedImages.markdown);
  const featureImage = await uploadLocalFeatureImage(
    vault,
    adapter,
    file,
    frontmatter.feature_image,
  );

  const input = {
    kind: contentKind(frontmatter),
    title: title || file.basename,
    body: cleanedContent,
    status: frontmatter.ghost_status || 'draft',
    tags: frontmatter.tags,
    summary: frontmatter.excerpt,
    featureImage: featureImage.featureImage,
  };
  const remotePost = adapter.createContent
    ? await adapter.createContent(input)
    : await adapter.createPost(input);

  await updateLocalFrontmatter(vault, localPost, remotePost, adapter.platform, cleanedContent);
  result.created.push(title || file.basename);
}

async function updateRemotePost(
  vault: Vault,
  adapter: CmsAdapter,
  localPost: LocalPost,
  content: string,
  settings: GhostSyncSettings,
  result: PushResult,
): Promise<void> {
  const { frontmatter, title, file } = localPost;
  if (!frontmatter.ghost_id) throw new Error('Cannot update post without ghost_id');

  let currentPost: RemotePost;
  try {
    currentPost = adapter.getContent
      ? await adapter.getContent(contentKind(frontmatter), frontmatter.ghost_id)
      : await adapter.getPost(frontmatter.ghost_id);
  } catch (error) {
    if (error instanceof CmsApiError && error.isNotFound()) {
      result.conflicts.push({
        localPost,
        ghostPost: null,
        type: 'deleted_remotely',
      });
      return;
    }
    throw error;
  }

  const withUploadedImages = await uploadLocalMarkdownImages(vault, adapter, file, content);
  const cleanedContent = cleanMarkdownForGhost(withUploadedImages.markdown);
  const featureImage = await uploadLocalFeatureImage(
    vault,
    adapter,
    file,
    frontmatter.feature_image,
  );

  try {
    const input = {
      kind: contentKind(frontmatter),
      title: title || file.basename,
      body: cleanedContent,
      status: frontmatter.ghost_status,
      tags: frontmatter.tags,
      summary: frontmatter.excerpt,
      featureImage: featureImage.featureImage,
    };
    const remotePost = adapter.updateContent
      ? await adapter.updateContent(
          contentKind(frontmatter),
          frontmatter.ghost_id,
          input,
          { updatedAt: currentPost.updatedAt },
        )
      : await adapter.updatePost(frontmatter.ghost_id, input, {
          updatedAt: currentPost.updatedAt,
        });

    await updateLocalFrontmatter(vault, localPost, remotePost, adapter.platform, cleanedContent);
    result.updated.push(title || file.basename);
  } catch (error) {
    if (error instanceof CmsApiError && error.isConflict()) {
      const freshPost = adapter.getContent
        ? await adapter.getContent(contentKind(frontmatter), frontmatter.ghost_id)
        : await adapter.getPost(frontmatter.ghost_id);

      if (settings.conflictStrategy === 'keep_local') {
        const input = {
          kind: contentKind(frontmatter),
          title: title || file.basename,
          body: cleanedContent,
          status: frontmatter.ghost_status,
          tags: frontmatter.tags,
          summary: frontmatter.excerpt,
          featureImage: featureImage.featureImage,
        };
        const retryPost = adapter.updateContent
          ? await adapter.updateContent(
              contentKind(frontmatter),
              frontmatter.ghost_id,
              input,
              { updatedAt: freshPost.updatedAt },
            )
          : await adapter.updatePost(frontmatter.ghost_id, input, {
              updatedAt: freshPost.updatedAt,
            });
        await updateLocalFrontmatter(vault, localPost, retryPost, adapter.platform, cleanedContent);
        result.updated.push(title || file.basename);
      } else if (settings.conflictStrategy === 'keep_remote') {
        result.skipped.push(title || file.basename);
      } else {
        result.conflicts.push({ localPost, ghostPost: freshPost, type: 'both_modified' });
      }
      return;
    }
    throw error;
  }
}

async function updateLocalFrontmatter(
  vault: Vault,
  localPost: LocalPost,
  remotePost: RemotePost,
  platform: CmsAdapter['platform'],
  content?: string,
): Promise<void> {
  const updated: PostFrontmatter = {
    ...localPost.frontmatter,
    cms_kind: remotePost.kind ?? contentKind(localPost.frontmatter),
    ghost_id: remotePost.id,
    ghost_slug: remotePost.slug,
    ghost_status: remotePost.status,
    ghost_updated_at: remotePost.updatedAt,
    local_updated_at: new Date().toISOString(),
    feature_image: remotePost.featureImage ?? localPost.frontmatter.feature_image,
  };
  const newContent = serializePostContent(updated, localPost.title, content ?? localPost.content, {
    platform,
    kind: updated.cms_kind ?? 'post',
  });
  await vault.write(localPost.file, newContent);
}

function contentKind(frontmatter: PostFrontmatter): ContentKind {
  return frontmatter.cms_kind ?? 'post';
}
