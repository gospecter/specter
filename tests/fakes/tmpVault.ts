/**
 * Helpers for putting a real `Vault` on top of a fresh temp directory so we
 * don't have to mock filesystem APIs. macOS tmpfs is fast enough that tests
 * still run in milliseconds.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../../src/vault.js';

export async function makeTmpVault(): Promise<{ vault: Vault; root: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ghost-sync-test-'));
  const vault = new Vault(root);
  const cleanup = async () => {
    try {
      await fs.rm(root, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  };
  return { vault, root, cleanup };
}

export async function writeFile(root: string, relPath: string, content: string): Promise<void> {
  const abs = path.join(root, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
}

export async function readFile(root: string, relPath: string): Promise<string> {
  return fs.readFile(path.join(root, relPath), 'utf8');
}

export async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, rel: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(abs, r);
      else out.push(r);
    }
  };
  await walk(root, '');
  return out.sort();
}
