import { CmsAdapter } from '../cms/adapter.js';
import { AdapterConfig } from '../cms/types.js';
import { createAdapter } from '../cms/index.js';
import {
  GhostSyncSettings,
  LocalPost,
  ConflictItem,
  SyncResult,
  VaultFile,
} from '../types.js';
import { parsePostContent } from '../utils/frontmatter.js';
import { pullFromGhost, PullResult } from './pull.js';
import { pushToGhost, pushSinglePost, PushResult } from './push.js';
import { resolveKeepLocal, resolveKeepRemote, ConflictResolution } from './conflict.js';
import { Vault, normalizePath } from '../vault.js';

export class SyncEngine {
  constructor(
    private vault: Vault,
    private adapter: CmsAdapter,
    private settings: GhostSyncSettings,
  ) {}

  /** Swap settings; if the credential block changed, rebuild the adapter. */
  updateSettings(settings: GhostSyncSettings, adapterConfig?: AdapterConfig): void {
    this.settings = settings;
    if (adapterConfig) this.adapter = createAdapter(adapterConfig);
  }

  async getLocalPosts(): Promise<Map<string, LocalPost>> {
    const posts = new Map<string, LocalPost>();
    const files = await this.vault.listMarkdownFiles(this.settings.syncFolderPath);

    for (const file of files) {
      try {
        const content = await this.vault.read(file);
        const parsed = parsePostContent(content);
        const localPost: LocalPost = {
          file,
          frontmatter: parsed.frontmatter,
          title: parsed.title,
          content: parsed.content,
          rawContent: content,
        };
        const key = parsed.frontmatter.ghost_id
          ? `${parsed.frontmatter.cms_kind ?? 'post'}:${parsed.frontmatter.ghost_id}`
          : file.path;
        posts.set(key, localPost);
      } catch (error) {
        console.error(`Error parsing ${file.path}:`, error);
      }
    }
    return posts;
  }

  async pull(): Promise<PullResult> {
    const existing = await this.getLocalPosts();
    return pullFromGhost(this.vault, this.adapter, this.settings, existing);
  }

  async push(maxUploads?: number): Promise<PushResult> {
    const localPosts = await this.getLocalPosts();
    return pushToGhost(
      this.vault,
      this.adapter,
      this.settings,
      Array.from(localPosts.values()),
      maxUploads,
    );
  }

  async pushFile(file: VaultFile): Promise<{
    success: boolean;
    error?: string;
    conflict?: ConflictItem;
  }> {
    const content = await this.vault.read(file);
    const parsed = parsePostContent(content);
    const localPost: LocalPost = {
      file,
      frontmatter: parsed.frontmatter,
      title: parsed.title,
      content: parsed.content,
      rawContent: content,
    };
    return pushSinglePost(this.vault, this.adapter, localPost, this.settings);
  }

  async fullSync(): Promise<SyncResult> {
    const result: SyncResult = { pulled: 0, pushed: 0, conflicts: [], errors: [] };

    const pullResult = await this.pull();
    result.pulled = pullResult.created.length + pullResult.updated.length;
    result.conflicts.push(...pullResult.conflicts);
    for (const err of pullResult.errors) {
      result.errors.push({ ghostId: err.post.id, message: err.error, recoverable: true });
    }

    const pushResult = await this.push();
    result.pushed = pushResult.created.length + pushResult.updated.length;
    result.conflicts.push(...pushResult.conflicts);
    for (const err of pushResult.errors) {
      result.errors.push({ file: err.file.path, message: err.error, recoverable: true });
    }

    return result;
  }

  async resolveConflict(conflict: ConflictItem, resolution: ConflictResolution): Promise<void> {
    switch (resolution) {
      case 'keep_local':
        await resolveKeepLocal(this.vault, this.adapter, conflict);
        break;
      case 'keep_remote':
        await resolveKeepRemote(this.vault, this.adapter, conflict);
        break;
      case 'skip':
        break;
    }
  }

  isInSyncFolder(file: VaultFile): boolean {
    const folder = normalizePath(this.settings.syncFolderPath);
    // Empty syncFolderPath means vaultPath itself IS the sync folder — every
    // .md file under it counts. This is the single-picker onboarding case.
    if (folder === '') return true;
    return file.path.startsWith(folder + '/');
  }

  async testConnection() {
    return this.adapter.testConnection();
  }
}
