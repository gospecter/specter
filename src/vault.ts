/**
 * Filesystem-backed vault adapter.
 *
 * Mirrors the slice of Obsidian's Vault API the sync code relies on, so the
 * ported sync/* modules read like the original Plugin code with `app.vault`
 * replaced by an injected adapter.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { VaultFile } from './types.js';

export class Vault {
  /**
   * @param root Absolute path to the vault root (e.g. /path/to/vault).
   *             All `VaultFile.path` values are relative to this.
   */
  constructor(private readonly root: string) {}

  private absolute(p: string): string {
    const resolvedRoot = path.resolve(this.root);
    const resolved = path.resolve(resolvedRoot, p);
    if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
      throw new Error(`Path escapes vault root: ${p}`);
    }
    return resolved;
  }

  private normalize(p: string): string {
    return p.replace(/^\/+/, '').replace(/\\/g, '/');
  }

  /** List all .md files recursively under `folderPath` (relative to vault root). */
  async listMarkdownFiles(folderPath: string): Promise<VaultFile[]> {
    const folder = this.normalize(folderPath);
    const absRoot = this.absolute(folder);
    const out: VaultFile[] = [];
    await this.walk(absRoot, folder, out);
    return out;
  }

  private async walk(absDir: string, relDir: string, out: VaultFile[]): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);
      const rel = path.posix.join(relDir, entry.name);
      if (entry.isDirectory()) {
        await this.walk(abs, rel, out);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        const stat = await fs.stat(abs);
        out.push({
          path: rel,
          basename: entry.name.replace(/\.md$/i, ''),
          mtime: stat.mtimeMs,
        });
      }
    }
  }

  async read(file: VaultFile): Promise<string> {
    return fs.readFile(this.absolute(file.path), 'utf8');
  }

  async readBinary(filePath: string): Promise<Uint8Array> {
    return fs.readFile(this.absolute(this.normalize(filePath)));
  }

  async write(file: VaultFile, content: string): Promise<VaultFile> {
    const abs = this.absolute(file.path);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    const stat = await fs.stat(abs);
    return { ...file, mtime: stat.mtimeMs };
  }

  async create(filePath: string, content: string): Promise<VaultFile> {
    const rel = this.normalize(filePath);
    const abs = this.absolute(rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    const stat = await fs.stat(abs);
    return {
      path: rel,
      basename: path.basename(rel).replace(/\.md$/i, ''),
      mtime: stat.mtimeMs,
    };
  }

  async trash(file: VaultFile): Promise<void> {
    await fs.unlink(this.absolute(file.path));
  }

  async exists(p: string): Promise<boolean> {
    try {
      await fs.access(this.absolute(this.normalize(p)));
      return true;
    } catch {
      return false;
    }
  }

  async ensureFolder(folderPath: string): Promise<void> {
    await fs.mkdir(this.absolute(this.normalize(folderPath)), { recursive: true });
  }

  /** Refresh mtime for a known file. */
  async refresh(file: VaultFile): Promise<VaultFile> {
    const stat = await fs.stat(this.absolute(file.path));
    return { ...file, mtime: stat.mtimeMs };
  }

  /**
   * Convert an absolute filesystem path into a `VaultFile` if it lives under
   * the vault root and is a .md file. Returns null otherwise.
   */
  async fromAbsolute(absPath: string): Promise<VaultFile | null> {
    const resolvedRoot = path.resolve(this.root);
    const resolved = path.resolve(absPath);
    if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
      return null;
    }
    if (!resolved.toLowerCase().endsWith('.md')) return null;
    let stat: import('node:fs').Stats;
    try {
      stat = await fs.stat(resolved);
    } catch {
      return null;
    }
    const rel = path.relative(resolvedRoot, resolved).split(path.sep).join('/');
    return {
      path: rel,
      basename: path.basename(rel).replace(/\.md$/i, ''),
      mtime: stat.mtimeMs,
    };
  }

  rootPath(): string {
    return this.root;
  }
}

export function normalizePath(p: string): string {
  return p.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\\/g, '/');
}
