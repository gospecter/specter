import { ConflictItem, LocalPost, PostFrontmatter } from '../types.js';
import { CmsAdapter } from '../cms/adapter.js';
import { RemotePost } from '../cms/types.js';
import { serializePostContent } from '../utils/frontmatter.js';
import { cleanMarkdownForGhost } from '../utils/markdown.js';
import { Vault } from '../vault.js';

export type ConflictResolution = 'keep_local' | 'keep_remote' | 'skip';

export async function resolveKeepLocal(
  vault: Vault,
  adapter: CmsAdapter,
  conflict: ConflictItem,
): Promise<void> {
  const { localPost, ghostPost: remotePost } = conflict;
  const cleaned = cleanMarkdownForGhost(localPost.content);

  if (conflict.type === 'deleted_remotely') {
    const created = await adapter.createPost({
      title: localPost.title || localPost.file.basename,
      body: cleaned,
      status: localPost.frontmatter.ghost_status || 'draft',
      tags: localPost.frontmatter.tags,
      summary: localPost.frontmatter.excerpt,
      featureImage: localPost.frontmatter.feature_image,
    });
    await applyRemoteData(vault, localPost, created, adapter.platform);
    return;
  }

  if (!remotePost) {
    throw new Error('Conflict type is not deleted_remotely but remotePost is null');
  }

  const updated = await adapter.updatePost(
    remotePost.id,
    {
      title: localPost.title || localPost.file.basename,
      body: cleaned,
      status: localPost.frontmatter.ghost_status,
      tags: localPost.frontmatter.tags,
      summary: localPost.frontmatter.excerpt,
      featureImage: localPost.frontmatter.feature_image,
    },
    { updatedAt: remotePost.updatedAt },
  );
  await applyRemoteData(vault, localPost, updated, adapter.platform);
}

export async function resolveKeepRemote(
  vault: Vault,
  adapter: CmsAdapter,
  conflict: ConflictItem,
): Promise<void> {
  const { localPost, ghostPost: remotePost } = conflict;

  if (conflict.type === 'deleted_remotely') {
    await vault.trash(localPost.file);
    return;
  }

  if (!remotePost) {
    throw new Error('Conflict type is not deleted_remotely but remotePost is null');
  }

  const fresh = await adapter.getPost(remotePost.id);
  const frontmatter: PostFrontmatter = {
    ghost_id: fresh.id,
    ghost_slug: fresh.slug,
    ghost_status: fresh.status,
    ghost_updated_at: fresh.updatedAt,
    local_updated_at: new Date().toISOString(),
    tags: fresh.tags,
    feature_image: fresh.featureImage,
    excerpt: fresh.summary,
  };
  const fileContent = serializePostContent(frontmatter, fresh.title, fresh.body, {
    platform: adapter.platform,
  });
  await vault.write(localPost.file, fileContent);
}

async function applyRemoteData(
  vault: Vault,
  localPost: LocalPost,
  remotePost: RemotePost,
  platform: CmsAdapter['platform'],
): Promise<void> {
  const updated: PostFrontmatter = {
    ...localPost.frontmatter,
    ghost_id: remotePost.id,
    ghost_slug: remotePost.slug,
    ghost_status: remotePost.status,
    ghost_updated_at: remotePost.updatedAt,
    local_updated_at: new Date().toISOString(),
  };
  const newContent = serializePostContent(updated, localPost.title, localPost.content, {
    platform,
  });
  await vault.write(localPost.file, newContent);
}

export function formatConflictInfo(conflict: ConflictItem): {
  title: string;
  localTime: Date;
  remoteTime: Date | null;
  type: string;
} {
  const localTime = new Date(
    conflict.localPost.frontmatter.local_updated_at || conflict.localPost.file.mtime,
  );
  let remoteTime: Date | null = null;
  if (conflict.ghostPost?.updatedAt) {
    remoteTime = new Date(conflict.ghostPost.updatedAt);
  }
  const typeLabels: Record<string, string> = {
    both_modified: 'Both versions modified',
    deleted_remotely: 'Deleted remotely',
    deleted_locally: 'Deleted locally',
  };
  return {
    title: conflict.localPost.title || conflict.localPost.file.basename,
    localTime,
    remoteTime,
    type: typeLabels[conflict.type] || conflict.type,
  };
}
