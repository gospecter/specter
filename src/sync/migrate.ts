/**
 * One-time vault layout migration (v0.6).
 *
 * Pre-v0.6, a single-target vault kept its posts at the bare `syncFolderPath`
 * (usually the vault root); only multi-target vaults namespaced each target
 * under its handle. That asymmetry meant connecting a second CMS appeared to
 * "move" the first one's files. Every target is now namespaced uniformly
 * (`src/sync/targets.ts:effectiveRoot`), so this migration relocates a legacy
 * single-target vault's files into the handle folder exactly once, then stamps
 * `config.vaultLayout = 'namespaced'` so it never runs again.
 *
 * Safety properties:
 *  - **Backup first.** Every file about to move is copied into
 *    `.specter-backup/<timestamp>/` (kept indefinitely) before any move, with
 *    an audit `migration-journal.json`. Dotfile-prefixed so the watcher ignores it.
 *  - **Frontmatter-gated root moves.** When the legacy location is the vault
 *    root (shared with the user's unrelated Obsidian notes), only `.md` files
 *    carrying Specter sync markers (`ghost_id`/`ghost_slug`) are moved; anything
 *    else is left untouched and reported in `skipped`.
 *  - **Relative links preserved.** A post's referenced local images are moved
 *    alongside it into the same relative position under the handle folder, so
 *    `![](images/x.png)` keeps resolving without rewriting the markdown.
 *  - **Binary-safe + resumable.** Moves use `fs.rename` (atomic within the
 *    vault filesystem; never read/rewrites bytes). The config marker is stamped
 *    only after all moves succeed, so a crash mid-migration simply re-runs and
 *    re-scans the (now-fewer) remaining files — idempotent by construction.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DaemonConfig, TargetConfig, saveConfig } from '../config.js';
import { effectiveRoot, legacyRoot } from './targets.js';
import { normalizePath } from '../vault.js';
import { parsePostContent } from '../utils/frontmatter.js';

export interface MigrateOptions {
  /** Plan and report without copying, moving, or stamping the config. */
  dryRun?: boolean;
  /** Progress sink. Defaults to no-op. */
  log?: (message: string) => void;
  /** Backup subdirectory name under `.specter-backup/`. Injectable for tests
   *  (the daemon defaults it to a timestamp). */
  backupLabel?: string;
}

export interface PlannedMove {
  /** Vault-relative source path. */
  from: string;
  /** Vault-relative destination path. */
  to: string;
  kind: 'post' | 'asset';
  /** Handle of the target this file belongs to. */
  handle: string;
  /**
   * `'move'` relocates the file; `'copy'` duplicates it and leaves the original
   * in place. Assets shared with an unmanaged note that stays at the vault root
   * are copied so that note's links don't break (the moved post gets its own
   * copy under the handle folder).
   */
  op: 'move' | 'copy';
}

export interface MigrateResult {
  /** True when files were actually relocated (false for dry-run / no-op). */
  migrated: boolean;
  moves: PlannedMove[];
  /** Root `.md` files left in place because they carry no Specter markers. */
  skipped: string[];
  /** Vault-relative backup directory, or null when nothing was backed up. */
  backupDir: string | null;
}

const IMAGE_EXTENSIONS = new Set([
  '.avif', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp',
]);

/**
 * Bring a vault up to the namespaced layout. No-op (returns `migrated: false`)
 * when the config is already stamped `namespaced`, when there is nothing to
 * move, or in dry-run mode.
 */
export async function migrateVaultLayout(
  config: DaemonConfig,
  options: MigrateOptions = {},
): Promise<MigrateResult> {
  const log = options.log ?? (() => undefined);
  const dryRun = options.dryRun ?? false;
  const vaultRoot = config.vaultPath;
  const result: MigrateResult = { migrated: false, moves: [], skipped: [], backupDir: null };

  if (config.vaultLayout === 'namespaced') return result;
  if (!vaultRoot) return result;

  // Multi-target legacy configs were already namespaced, so their legacy and
  // effective roots match and produce no moves.
  const wasMulti = config.targets.length > 1;

  for (const target of config.targets) {
    const from = normalizePath(legacyRoot(target, wasMulti));
    const to = normalizePath(effectiveRoot(target));
    if (from === to) continue;
    const { moves, skipped } = await planTargetMove(vaultRoot, target, from, to);
    result.moves.push(...moves);
    result.skipped.push(...skipped);
  }

  if (result.skipped.length > 0) {
    log(
      `vault layout: leaving ${result.skipped.length} unmanaged file(s) at the vault root in place`,
    );
  }

  // Nothing physically to move (fresh/empty vault, or only unmanaged files):
  // still stamp so we don't re-scan on every start.
  if (result.moves.length === 0) {
    if (!dryRun) {
      config.vaultLayout = 'namespaced';
      await saveConfig(config);
    }
    log('vault layout: nothing to migrate (marked namespaced)');
    return result;
  }

  // Destination safety pre-flight — runs BEFORE any disk write, so a violation
  // aborts cleanly with nothing half-done and the config left unstamped:
  //  - no two planned files may target the same destination, and
  //  - no destination may already exist on disk (`fs.rename` would silently
  //    clobber it, and the clobbered file is NOT in the backup).
  // Aborting is safer than guessing: the user resolves the conflict and retries.
  await assertDestinationsSafe(vaultRoot, result.moves);

  if (dryRun) {
    log(`vault layout: would move ${result.moves.length} file(s) into handle folder(s)`);
    return result;
  }

  // 1. Backup every source file before touching anything.
  const label = options.backupLabel ?? new Date().toISOString().replace(/[:.]/g, '-');
  const backupRel = `.specter-backup/${label}`;
  result.backupDir = backupRel;
  for (const move of result.moves) {
    await copyFileWithin(vaultRoot, move.from, path.posix.join(backupRel, move.from));
  }
  await writeJournal(vaultRoot, backupRel, result);

  // 2. Relocate. Plans were collected up-front, so a rename never disturbs a
  //    not-yet-scanned file (matters when `to` nests under `from`).
  for (const move of result.moves) {
    if (move.op === 'copy') {
      await copyFileWithin(vaultRoot, move.from, move.to);
      log(`copied ${move.from} → ${move.to} (shared asset; original kept)`);
    } else {
      await renameWithin(vaultRoot, move.from, move.to);
      log(`moved ${move.from} → ${move.to}`);
    }
  }

  // 3. Stamp only after every move succeeded.
  config.vaultLayout = 'namespaced';
  await saveConfig(config);
  result.migrated = true;
  log(
    `vault layout migrated: ${result.moves.length} file(s) namespaced (backup at ${backupRel})`,
  );
  return result;
}

/** Build the move list for one target. */
async function planTargetMove(
  vaultRoot: string,
  target: TargetConfig,
  from: string,
  to: string,
): Promise<{ moves: PlannedMove[]; skipped: string[] }> {
  const moves: PlannedMove[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();

  if (from === '') {
    // ROOT case: the vault root is shared with the user's other notes. Move
    // only top-level `.md` files that carry Specter sync markers; leave the
    // rest (and remember what assets they reference) in place.
    const names = await readDirSafe(vaultRoot);
    const managed: Array<{ rel: string; abs: string }> = [];
    const unmanaged: Array<{ rel: string; abs: string }> = [];
    for (const name of names.sort()) {
      if (name.startsWith('.')) continue;
      if (!name.toLowerCase().endsWith('.md')) continue;
      const abs = path.join(vaultRoot, name);
      if (!(await isFile(abs))) continue;
      if (await isManagedPost(abs)) managed.push({ rel: name, abs });
      else {
        unmanaged.push({ rel: name, abs });
        skipped.push(name);
      }
    }

    // Assets still referenced by a note that STAYS at the root: copying instead
    // of moving keeps that note's links intact while the moved post gets its own.
    const protectedAssets = new Set<string>();
    for (const note of unmanaged) {
      for (const a of await referencedLocalAssets(vaultRoot, note.abs, note.rel)) {
        protectedAssets.add(a);
      }
    }

    for (const post of managed) {
      pushMove(moves, seen, {
        from: post.rel,
        to: path.posix.join(to, post.rel),
        kind: 'post',
        handle: target.handle,
        op: 'move',
      });
      // Co-locate referenced local images so relative links survive the move.
      for (const assetRel of await referencedLocalAssets(vaultRoot, post.abs, post.rel)) {
        pushMove(moves, seen, {
          from: assetRel,
          to: path.posix.join(to, assetRel),
          kind: 'asset',
          handle: target.handle,
          op: protectedAssets.has(assetRel) ? 'copy' : 'move',
        });
      }
    }
  } else {
    // SUBFOLDER case: shift the whole `from` subtree to `to`. Relative links
    // within the subtree stay valid because everything moves together. Skip
    // anything already under `to` — this makes a crashed run resumable even
    // when `to` nests inside `from` (handle == syncFolderPath), where a naive
    // re-walk would otherwise bury already-moved files one level deeper.
    const files = await walkAll(vaultRoot, from);
    for (const rel of files) {
      if (rel === to || rel.startsWith(to + '/')) continue;
      const tail = rel.slice(from.length).replace(/^\/+/, '');
      pushMove(moves, seen, {
        from: rel,
        to: path.posix.join(to, tail),
        kind: rel.toLowerCase().endsWith('.md') ? 'post' : 'asset',
        handle: target.handle,
        op: 'move',
      });
    }
  }

  return { moves, skipped };
}

/**
 * Abort the migration if any destination is unsafe: two sources colliding on
 * one destination, or a destination that already exists on disk (a rename/copy
 * there would clobber a file the backup never captured). Throwing here — before
 * any write — leaves the vault and config untouched so the user can resolve the
 * conflict and re-run.
 */
async function assertDestinationsSafe(vaultRoot: string, moves: PlannedMove[]): Promise<void> {
  const claimed = new Map<string, string>();
  for (const m of moves) {
    const prior = claimed.get(m.to);
    if (prior !== undefined) {
      throw new Error(
        `Vault migration aborted: "${prior}" and "${m.from}" would both move to "${m.to}". ` +
          `Resolve the duplicate, then retry.`,
      );
    }
    claimed.set(m.to, m.from);
    if (await isFile(path.join(vaultRoot, m.to))) {
      throw new Error(
        `Vault migration aborted: destination "${m.to}" already exists. ` +
          `Move or remove it, then retry.`,
      );
    }
  }
}

function pushMove(moves: PlannedMove[], seen: Set<string>, move: PlannedMove): void {
  if (seen.has(move.from)) return;
  if (move.from === move.to) return;
  seen.add(move.from);
  moves.push(move);
}

/**
 * A `.md` file is Specter-managed if its frontmatter carries a CMS id/slug, or
 * `local_updated_at` (a Specter-only key written for pushed-but-not-yet-pulled
 * drafts that have no `ghost_id` yet). All three are Specter-specific, so the
 * false-positive risk on a user's hand-written note is negligible.
 */
async function isManagedPost(abs: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(abs, 'utf8');
    const { frontmatter } = parsePostContent(raw);
    return (
      Boolean(frontmatter.ghost_id) ||
      Boolean(frontmatter.ghost_slug) ||
      Boolean(frontmatter.local_updated_at)
    );
  } catch {
    return false;
  }
}

/**
 * Vault-relative paths of local images a markdown file references (body images
 * + `feature_image`). Remote URLs, data URIs, anchors, and refs that escape the
 * vault are excluded. The file must still resolve as `from`-rooted, so callers
 * mirror these under the new root to keep links intact.
 */
async function referencedLocalAssets(
  vaultRoot: string,
  abs: string,
  mdRel: string,
): Promise<string[]> {
  let raw: string;
  try {
    raw = await fs.readFile(abs, 'utf8');
  } catch {
    return [];
  }
  const { frontmatter } = parsePostContent(raw);
  const baseDir = path.posix.dirname(mdRel) === '.' ? '' : path.posix.dirname(mdRel);
  const out: string[] = [];
  const add = (target: string | null) => {
    if (!target || !isLocalImageTarget(target)) return;
    const clean = decodeURIComponent(target.split(/[?#]/, 1)[0]);
    const rel = clean.startsWith('/')
      ? normalizePath(clean)
      : normalizePath(path.posix.join(baseDir, clean));
    // Reject anything that escapes the vault (e.g. `../x.png`).
    if (rel.startsWith('..') || rel === '' || out.includes(rel)) return;
    out.push(rel);
  };

  add(frontmatter.feature_image ?? null);
  const imageRe = /!\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match: RegExpExecArray | null;
  while ((match = imageRe.exec(raw)) !== null) {
    const rawTarget = match[1];
    add(rawTarget.startsWith('<') && rawTarget.endsWith('>') ? rawTarget.slice(1, -1) : rawTarget);
  }
  return out;
}

function isLocalImageTarget(target: string): boolean {
  const lower = target.toLowerCase();
  if (
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('//') ||
    lower.startsWith('data:') ||
    lower.startsWith('mailto:') ||
    lower.startsWith('#')
  ) {
    return false;
  }
  return IMAGE_EXTENSIONS.has(path.posix.extname(lower.split(/[?#]/, 1)[0]));
}

/** Recursively list vault-relative file paths under `relDir`, skipping
 *  dot-prefixed entries (`.obsidian`, `.specter-backup`, …). */
async function walkAll(vaultRoot: string, relDir: string): Promise<string[]> {
  const out: string[] = [];
  const recurse = async (rel: string): Promise<void> => {
    const abs = path.join(vaultRoot, rel);
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const childRel = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) {
        await recurse(childRel);
      } else if (entry.isFile()) {
        out.push(childRel);
      }
    }
  };
  await recurse(normalizePath(relDir));
  return out;
}

async function readDirSafe(absDir: string): Promise<string[]> {
  try {
    return await fs.readdir(absDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function isFile(abs: string): Promise<boolean> {
  try {
    return (await fs.stat(abs)).isFile();
  } catch {
    return false;
  }
}

async function copyFileWithin(vaultRoot: string, fromRel: string, toRel: string): Promise<void> {
  const fromAbs = path.join(vaultRoot, fromRel);
  const toAbs = path.join(vaultRoot, toRel);
  await fs.mkdir(path.dirname(toAbs), { recursive: true });
  await fs.copyFile(fromAbs, toAbs);
}

async function renameWithin(vaultRoot: string, fromRel: string, toRel: string): Promise<void> {
  const fromAbs = path.join(vaultRoot, fromRel);
  const toAbs = path.join(vaultRoot, toRel);
  await fs.mkdir(path.dirname(toAbs), { recursive: true });
  try {
    await fs.rename(fromAbs, toAbs);
  } catch (err) {
    // Cross-device (EXDEV) shouldn't happen within one vault, but fall back to
    // copy+unlink so the move still completes if it does.
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      await fs.copyFile(fromAbs, toAbs);
      await fs.unlink(fromAbs);
      return;
    }
    throw err;
  }
}

async function writeJournal(
  vaultRoot: string,
  backupRel: string,
  result: MigrateResult,
): Promise<void> {
  const journal = {
    createdAt: new Date().toISOString(),
    note: 'Specter vault layout migration. Originals copied here before the move.',
    moves: result.moves,
    skipped: result.skipped,
  };
  const abs = path.join(vaultRoot, backupRel, 'migration-journal.json');
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, JSON.stringify(journal, null, 2) + '\n', 'utf8');
}
