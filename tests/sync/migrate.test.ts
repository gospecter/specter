/**
 * Vault layout migration tests (v0.6).
 *
 * Covers the one-time relocation of legacy single-target vaults into the
 * namespaced layout: the high-value cases (root-synced, subfolder-synced),
 * the safety gates (unmanaged files left alone, backup taken, links preserved,
 * binary assets uncorrupted), and idempotency / no-op paths.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DaemonConfig, TargetConfig } from '../../src/config.js';
import { DEFAULT_SETTINGS } from '../../src/types.js';
import { migrateVaultLayout } from '../../src/sync/migrate.js';

let vault: string;
let configHome: string;
let originalXdg: string | undefined;

beforeEach(async () => {
  vault = await fs.mkdtemp(path.join(os.tmpdir(), 'specter-migrate-'));
  // Isolate saveConfig writes (migrateVaultLayout stamps the config) so the
  // suite never touches the developer's real ~/.config/ghost-sync/config.json.
  configHome = await fs.mkdtemp(path.join(os.tmpdir(), 'specter-migrate-cfg-'));
  originalXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = configHome;
});

afterEach(async () => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  await fs.rm(vault, { recursive: true, force: true });
  await fs.rm(configHome, { recursive: true, force: true });
});

function target(overrides: Partial<TargetConfig> = {}): TargetConfig {
  return {
    handle: 'ghost',
    label: 'Ghost',
    syncFolderPath: '',
    pullDrafts: true,
    pullPublished: true,
    conflictStrategy: 'ask',
    syncMode: 'auto',
    contentKinds: ['post'],
    adapter: { platform: 'ghost', ghostUrl: 'u', adminApiKey: 'k' },
    ...overrides,
  };
}

function config(targets: TargetConfig[], overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    ...DEFAULT_SETTINGS,
    vaultPath: vault,
    watchDebounceMs: 2000,
    targets,
    ...overrides,
  } as DaemonConfig;
}

const POST = (id: string, body = 'Body.') =>
  `---\nghost_id: ${id}\nghost_slug: ${id}-slug\nghost_status: published\n---\n\n# ${id}\n\n${body}\n`;

async function write(rel: string, content: string | Buffer): Promise<void> {
  const abs = path.join(vault, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

async function exists(rel: string): Promise<boolean> {
  try {
    await fs.access(path.join(vault, rel));
    return true;
  } catch {
    return false;
  }
}

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(vault, rel), 'utf8');
}

describe('migrateVaultLayout — root-synced single target', () => {
  it('moves managed .md files into the handle folder and stamps the config', async () => {
    await write('First-Post.md', POST('a'));
    await write('Second-Post.md', POST('b'));
    const cfg = config([target({ handle: 'studio', syncFolderPath: '' })]);

    const result = await migrateVaultLayout(cfg, { backupLabel: 'test' });

    expect(result.migrated).toBe(true);
    expect(await exists('studio/First-Post.md')).toBe(true);
    expect(await exists('studio/Second-Post.md')).toBe(true);
    expect(await exists('First-Post.md')).toBe(false);
    expect(await exists('Second-Post.md')).toBe(false);
    expect(cfg.vaultLayout).toBe('namespaced');
  });

  it('leaves unmanaged root notes (no sync markers) untouched', async () => {
    await write('Synced.md', POST('a'));
    await write('My Personal Note.md', '# Just my notes\n\nNothing to do with Specter.\n');
    const cfg = config([target({ handle: 'studio' })]);

    const result = await migrateVaultLayout(cfg, { backupLabel: 'test' });

    expect(await exists('studio/Synced.md')).toBe(true);
    expect(await exists('My Personal Note.md')).toBe(true); // left in place
    expect(await exists('studio/My Personal Note.md')).toBe(false);
    expect(result.skipped).toContain('My Personal Note.md');
  });

  it('backs up every moved file before moving it', async () => {
    await write('Post.md', POST('a'));
    const cfg = config([target({ handle: 'studio' })]);

    await migrateVaultLayout(cfg, { backupLabel: 'snap' });

    expect(await exists('.specter-backup/snap/Post.md')).toBe(true);
    expect(await read('.specter-backup/snap/Post.md')).toBe(POST('a'));
    expect(await exists('.specter-backup/snap/migration-journal.json')).toBe(true);
  });

  it('co-moves a referenced local image so the relative link stays valid', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);
    await write('images/hero.png', png);
    await write('Post.md', POST('a', 'Look: ![hero](images/hero.png)'));
    const cfg = config([target({ handle: 'studio' })]);

    await migrateVaultLayout(cfg, { backupLabel: 'test' });

    // Both post and image moved under the handle, preserving the relative path.
    expect(await exists('studio/Post.md')).toBe(true);
    expect(await exists('studio/images/hero.png')).toBe(true);
    expect(await exists('images/hero.png')).toBe(false);
    // Link text unchanged → still resolves from studio/Post.md.
    expect(await read('studio/Post.md')).toContain('![hero](images/hero.png)');
    // Binary integrity preserved (rename, not utf8 rewrite).
    const moved = await fs.readFile(path.join(vault, 'studio/images/hero.png'));
    expect(Buffer.compare(moved, png)).toBe(0);
  });

  it('does not move assets that escape the vault root (../)', async () => {
    await write('Post.md', POST('a', '![x](../outside.png)'));
    const cfg = config([target({ handle: 'studio' })]);
    const result = await migrateVaultLayout(cfg, { backupLabel: 'test' });
    expect(result.moves.some((m) => m.kind === 'asset')).toBe(false);
  });
});

describe('migrateVaultLayout — subfolder-synced single target', () => {
  it('shifts the whole subtree under the handle', async () => {
    await write('posts/A.md', POST('a'));
    await write('posts/nested/B.md', POST('b'));
    await write('posts/assets/img.png', Buffer.from([1, 2, 3]));
    const cfg = config([target({ handle: 'blog', syncFolderPath: 'posts' })]);

    await migrateVaultLayout(cfg, { backupLabel: 'test' });

    expect(await exists('blog/posts/A.md')).toBe(true);
    expect(await exists('blog/posts/nested/B.md')).toBe(true);
    expect(await exists('blog/posts/assets/img.png')).toBe(true);
    expect(await exists('posts/A.md')).toBe(false);
  });
});

describe('migrateVaultLayout — no-op and idempotency', () => {
  it('is a no-op when already stamped namespaced', async () => {
    await write('Post.md', POST('a')); // would move, but marker says done
    const cfg = config([target({ handle: 'studio' })], { vaultLayout: 'namespaced' });

    const result = await migrateVaultLayout(cfg, { backupLabel: 'test' });

    expect(result.migrated).toBe(false);
    expect(result.moves).toHaveLength(0);
    expect(await exists('Post.md')).toBe(true); // untouched
  });

  it('multi-target legacy configs (already namespaced) move nothing but stamp', async () => {
    await write('a/Post.md', POST('a'));
    await write('b/Post.md', POST('b'));
    const cfg = config([
      target({ handle: 'a', syncFolderPath: '' }),
      target({ handle: 'b', syncFolderPath: '' }),
    ]);

    const result = await migrateVaultLayout(cfg, { backupLabel: 'test' });

    expect(result.moves).toHaveLength(0);
    expect(cfg.vaultLayout).toBe('namespaced');
    expect(await exists('a/Post.md')).toBe(true);
  });

  it('running twice is safe — second pass moves nothing', async () => {
    await write('Post.md', POST('a'));
    const cfg = config([target({ handle: 'studio' })]);

    await migrateVaultLayout(cfg, { backupLabel: 'one' });
    const second = await migrateVaultLayout(cfg, { backupLabel: 'two' });

    expect(second.migrated).toBe(false);
    expect(second.moves).toHaveLength(0);
    expect(await exists('studio/Post.md')).toBe(true);
  });

  it('aborts (no data loss) when a destination already exists on disk', async () => {
    await write('Post.md', POST('a', 'new body'));
    // A pre-existing file already occupies the destination — must NOT be clobbered.
    await write('studio/Post.md', POST('a', 'EXISTING — do not lose me'));
    const cfg = config([target({ handle: 'studio' })]);

    await expect(migrateVaultLayout(cfg, { backupLabel: 'test' })).rejects.toThrow(/already exists/);
    // Nothing moved, nothing stamped, existing file intact.
    expect(await read('studio/Post.md')).toContain('EXISTING — do not lose me');
    expect(await exists('Post.md')).toBe(true);
    expect(cfg.vaultLayout).toBeUndefined();
  });

  it('resumes safely when `to` nests under `from` (handle == syncFolderPath)', async () => {
    // from='posts', to='posts/posts'. Simulate a crashed first run: A already
    // moved into posts/posts, B still at posts. Re-running must finish, not bury A.
    await write('posts/posts/A.md', POST('a'));
    await write('posts/B.md', POST('b'));
    const cfg = config([target({ handle: 'posts', syncFolderPath: 'posts' })]);

    const result = await migrateVaultLayout(cfg, { backupLabel: 'resume' });

    expect(await exists('posts/posts/A.md')).toBe(true); // not buried deeper
    expect(await exists('posts/posts/posts/A.md')).toBe(false);
    expect(await exists('posts/posts/B.md')).toBe(true); // finished
    expect(await exists('posts/B.md')).toBe(false);
    expect(cfg.vaultLayout).toBe('namespaced');
    expect(result.moves.every((m) => !m.from.startsWith('posts/posts'))).toBe(true);
  });

  it('copies (not moves) an asset shared with an unmanaged root note', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x09, 0x09]);
    await write('shared.png', png);
    await write('Synced.md', POST('a', '![s](shared.png)'));
    await write('Personal.md', '# Personal\n\n![s](shared.png)\n'); // unmanaged, stays
    const cfg = config([target({ handle: 'studio' })]);

    await migrateVaultLayout(cfg, { backupLabel: 'test' });

    // Managed post + its own copy of the image moved under the handle…
    expect(await exists('studio/Synced.md')).toBe(true);
    expect(await exists('studio/shared.png')).toBe(true);
    // …and the original image stays so the unmanaged note's link still resolves.
    expect(await exists('shared.png')).toBe(true);
    expect(await exists('Personal.md')).toBe(true);
  });

  it('dry-run reports moves without touching disk or stamping', async () => {
    await write('Post.md', POST('a'));
    const cfg = config([target({ handle: 'studio' })]);

    const result = await migrateVaultLayout(cfg, { dryRun: true, backupLabel: 'test' });

    expect(result.migrated).toBe(false);
    expect(result.moves.length).toBeGreaterThan(0);
    expect(await exists('Post.md')).toBe(true); // not moved
    expect(await exists('studio/Post.md')).toBe(false);
    expect(cfg.vaultLayout).toBeUndefined(); // not stamped
  });
});
