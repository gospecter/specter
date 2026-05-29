import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { WordPressAdapter } from '../../src/wordpress/adapter.js';
import { SyncEngine } from '../../src/sync/engine.js';
import { Vault } from '../../src/vault.js';
import { DEFAULT_SETTINGS, GhostSyncSettings } from '../../src/types.js';
import { parsePostContent, serializePostContent } from '../../src/utils/frontmatter.js';
import { FakeWordPressApi } from '../fakes/FakeWordPressApi.js';
import { makeTmpVault, readFile, writeFile } from '../fakes/tmpVault.js';

function settings(overrides: Partial<GhostSyncSettings> = {}): GhostSyncSettings {
  return { ...DEFAULT_SETTINGS, syncFolderPath: '', ...overrides };
}

describe('SyncEngine with WordPress content kinds', () => {
  let vault: Vault;
  let root: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ vault, root, cleanup } = await makeTmpVault());
  });

  afterEach(async () => {
    await cleanup();
  });

  it('pushes a local page draft and assigns uploaded featured media', async () => {
    await fs.mkdir(path.join(root, 'assets'), { recursive: true });
    await fs.writeFile(path.join(root, 'assets', 'hero.jpg'), 'fake image bytes');

    const local = serializePostContent(
      {
        cms_kind: 'page',
        ghost_id: null,
        ghost_slug: null,
        ghost_status: 'draft',
        ghost_updated_at: null,
        local_updated_at: null,
        tags: [],
        feature_image: 'assets/hero.jpg',
        excerpt: null,
      },
      'WordPress About',
      'About page body.',
      { platform: 'wordpress', kind: 'page' },
    );
    await writeFile(root, 'wordpress-about.md', local);

    const api = new FakeWordPressApi();
    const adapter = new WordPressAdapter(api, 'https://fake.example.com');
    const engine = new SyncEngine(vault, adapter, settings());

    const result = await engine.push();

    expect(result.created).toEqual(['WordPress About']);
    expect(api.uploadMediaCount).toBe(1);
    expect(api.pages.size).toBe(1);
    const page = Array.from(api.pages.values())[0];
    expect(page.featured_media).toBeGreaterThan(0);

    const updated = parsePostContent(await readFile(root, 'wordpress-about.md'));
    expect(updated.frontmatter.cms_kind).toBe('page');
    expect(updated.frontmatter.feature_image).toBe('https://fake.example.com/wp-content/uploads/hero.jpg');
  });
});
