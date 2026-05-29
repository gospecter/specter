import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTmpVault } from './fakes/tmpVault.js';
import type { Vault } from '../src/vault.js';

describe('Vault path containment', () => {
  let vault: Vault;
  let root: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ vault, root, cleanup } = await makeTmpVault());
  });

  afterEach(async () => {
    await cleanup();
  });

  it('rejects writes that escape the vault root', async () => {
    await expect(vault.create('../outside.md', 'nope')).rejects.toThrow(/escapes vault root/);

    await expect(fs.access(path.join(path.dirname(root), 'outside.md'))).rejects.toThrow();
  });

  it('rejects folder creation outside the vault root', async () => {
    await expect(vault.ensureFolder('../../outside-folder')).rejects.toThrow(/escapes vault root/);
  });

  it('still allows normal nested paths inside the vault', async () => {
    const file = await vault.create('posts/hello.md', '# Hello');

    expect(file.path).toBe('posts/hello.md');
    await expect(fs.readFile(path.join(root, 'posts', 'hello.md'), 'utf8')).resolves.toBe('# Hello');
  });
});
