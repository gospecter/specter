/**
 * Dry-run adapters. Drop-in replacements for `Vault` and `CmsAdapter` that
 * record intended operations into a shared `SyncPlan` instead of executing
 * them. The engine code is unmodified — it just gets handed these proxies
 * in place of the real adapters.
 *
 * Read-only operations (Vault.read/list/exists, adapter.listPosts/getPost,
 * adapter.listContainers) pass through to the real implementation so the
 * planning decisions are based on actual state. Only writes are intercepted.
 */

import path from 'node:path';
import { CmsAdapter } from '../cms/adapter.js';
import {
  CreatePostInput,
  ListOptions,
  Platform,
  RemoteContainer,
  RemotePost,
  UpdatePostInput,
} from '../cms/types.js';
import { PlanEntry, SyncPlan, VaultFile } from '../types.js';
import { Vault } from '../vault.js';

export function emptyPlan(direction: SyncPlan['direction']): SyncPlan {
  return {
    direction,
    creates: [],
    updates: [],
    metadataUpdates: [],
    deletes: [],
    conflicts: [],
    skips: [],
    errors: [],
  };
}

/** Strip a leading YAML frontmatter block. Used to decide whether a write is
 *  body-changing or metadata-only. */
function bodyOnly(content: string): string {
  if (!content.startsWith('---')) return content;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return content;
  return content.slice(end + 4).trim();
}

export class DryRunVault extends Vault {
  /** Paths that the engine has asked to create during this run. Used by
   *  `exists()` so `uniqueFilePath` doesn't hand out the same name twice. */
  private pendingCreates = new Set<string>();

  constructor(
    root: string,
    public readonly plan: SyncPlan,
  ) {
    super(root);
  }

  private normalizeLocal(p: string): string {
    return p.replace(/^\/+/, '').replace(/\\/g, '/');
  }

  override async write(file: VaultFile, content: string): Promise<VaultFile> {
    let entry: PlanEntry;
    try {
      const current = await super.read(file);
      const isMetadataOnly = bodyOnly(current) === bodyOnly(content);
      entry = {
        side: 'local',
        title: file.basename,
        localPath: file.path,
        details: isMetadataOnly
          ? 'would update sync metadata (frontmatter only)'
          : 'would overwrite local file with remote content',
      };
      (isMetadataOnly ? this.plan.metadataUpdates : this.plan.updates).push(entry);
    } catch {
      // File didn't exist — treat as a real new write.
      this.plan.updates.push({
        side: 'local',
        title: file.basename,
        localPath: file.path,
        details: 'would write new local file',
      });
    }
    return file;
  }

  override async create(filePath: string, _content: string): Promise<VaultFile> {
    const rel = this.normalizeLocal(filePath);
    this.pendingCreates.add(rel);
    const basename = path.basename(rel).replace(/\.md$/i, '');
    this.plan.creates.push({
      side: 'local',
      title: basename,
      localPath: rel,
      details: 'would create local file',
    });
    return { path: rel, basename, mtime: Date.now() };
  }

  override async trash(file: VaultFile): Promise<void> {
    this.plan.deletes.push({
      side: 'local',
      title: file.basename,
      localPath: file.path,
      details: 'would delete local file',
    });
  }

  override async exists(p: string): Promise<boolean> {
    if (this.pendingCreates.has(this.normalizeLocal(p))) return true;
    return super.exists(p);
  }

  override async ensureFolder(_folderPath: string): Promise<void> {
    // No-op in dry-run. Creating a folder is harmless either way, but we
    // skip it to keep dry runs truly side-effect free.
  }
}

/** A synthetic RemotePost the push code can hand to `updateLocalFrontmatter`
 *  without crashing. The DryRunVault then intercepts the local write. */
function syntheticRemotePost(
  source: { id?: string; title?: string; slug?: string; status?: RemotePost['status'] },
): RemotePost {
  const id = source.id ?? `dry-run-${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  return {
    id,
    slug: source.slug ?? '',
    title: source.title ?? '',
    body: '',
    status: source.status ?? 'draft',
    tags: [],
    summary: null,
    featureImage: null,
    author: null,
    updatedAt: now,
    createdAt: now,
    publishedAt: null,
    container: null,
    url: null,
  };
}

/**
 * Wraps a real `CmsAdapter` (so reads return live state) but intercepts every
 * mutation, recording it as a `PlanEntry` in `plan`. No HTTP write goes out.
 */
export class DryRunAdapter implements CmsAdapter {
  readonly platform: Platform;

  constructor(
    private inner: CmsAdapter,
    public readonly plan: SyncPlan,
  ) {
    this.platform = inner.platform;
  }

  testConnection(): Promise<{ ok: boolean; message: string }> {
    return this.inner.testConnection();
  }

  listPosts(options?: ListOptions): Promise<RemotePost[]> {
    return this.inner.listPosts(options);
  }

  getPost(id: string): Promise<RemotePost> {
    return this.inner.getPost(id);
  }

  listContainers(): Promise<RemoteContainer[]> {
    return this.inner.listContainers();
  }

  async createPost(input: CreatePostInput): Promise<RemotePost> {
    this.plan.creates.push({
      side: 'remote',
      title: input.title,
      details: `would create remote post (status: ${input.status ?? 'draft'})`,
    });
    return syntheticRemotePost({ title: input.title, status: input.status });
  }

  async updatePost(id: string, input: UpdatePostInput): Promise<RemotePost> {
    this.plan.updates.push({
      side: 'remote',
      ghostId: id,
      title: input.title ?? '',
      details: 'would update remote post',
    });
    return syntheticRemotePost({
      id,
      title: input.title,
      slug: input.slug,
      status: input.status,
    });
  }

  async deletePost(id: string): Promise<void> {
    this.plan.deletes.push({
      side: 'remote',
      ghostId: id,
      title: '',
      details: 'would delete remote post',
    });
  }
}

/** Render a plan as a human-readable text block for the CLI. */
export function formatPlan(plan: SyncPlan): string {
  const lines: string[] = [];
  lines.push(`Dry run plan (${plan.direction})`);
  lines.push('─'.repeat(40));

  const section = (title: string, entries: PlanEntry[], symbol: string) => {
    if (entries.length === 0) return;
    lines.push(`${symbol} ${title} (${entries.length})`);
    for (const e of entries.slice(0, 50)) {
      const where = e.side === 'remote' ? '(remote)' : '(local)';
      const target = e.localPath ? `→ ${e.localPath}` : e.ghostId ? `→ id:${e.ghostId}` : '';
      lines.push(`  ${symbol} ${e.title || '(untitled)'} ${where} ${target}`.trimEnd());
      if (e.details) lines.push(`       ${e.details}`);
    }
    if (entries.length > 50) {
      lines.push(`  … and ${entries.length - 50} more`);
    }
    lines.push('');
  };

  section('Creates', plan.creates, '+');
  section('Updates', plan.updates, '~');
  section('Conflicts', plan.conflicts, '!');
  section('Deletes', plan.deletes, '-');
  section('Errors', plan.errors, 'x');
  if (plan.metadataUpdates.length > 0) {
    lines.push(`(also ${plan.metadataUpdates.length} sync-metadata writes — not shown)`);
  }
  if (plan.skips.length > 0) {
    lines.push(`Skipped: ${plan.skips.length} already in sync`);
  }
  return lines.join('\n');
}

/** Compact one-line summary, used for notifications. */
export function planSummary(plan: SyncPlan): string {
  const parts: string[] = [];
  if (plan.creates.length) parts.push(`${plan.creates.length} create`);
  if (plan.updates.length) parts.push(`${plan.updates.length} update`);
  if (plan.deletes.length) parts.push(`${plan.deletes.length} delete`);
  if (plan.conflicts.length) parts.push(`${plan.conflicts.length} conflict`);
  if (plan.errors.length) parts.push(`${plan.errors.length} error`);
  if (parts.length === 0) return 'no changes';
  return parts.join(', ');
}
