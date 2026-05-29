import { describe, expect, it } from 'vitest';
import { WordPressAdapter } from '../../src/wordpress/adapter.js';
import { FakeWordPressApi } from '../fakes/FakeWordPressApi.js';

describe('WordPress content API', () => {
  it('creates, lists, updates, and deletes pages as content kind page', async () => {
    const api = new FakeWordPressApi();
    const adapter = new WordPressAdapter(api, 'https://fake.example.com');

    const created = await adapter.createContent({
      kind: 'page',
      title: 'About',
      body: 'Page **body**',
      status: 'draft',
    });
    expect(created.kind).toBe('page');
    expect(created.title).toBe('About');
    expect(created.body).toContain('body');

    const all = await adapter.listContent({ kinds: ['page'] });
    expect(all).toEqual([
      expect.objectContaining({ id: created.id, kind: 'page', title: 'About' }),
    ]);

    const updated = await adapter.updateContent(
      'page',
      created.id,
      { title: 'About us', body: 'Updated page' },
      { updatedAt: created.updatedAt },
    );
    expect(updated.kind).toBe('page');
    expect(updated.title).toBe('About us');
    expect(updated.body).toContain('Updated page');

    await adapter.deleteContent('page', created.id);
    await expect(adapter.getContent('page', created.id)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('uses uploaded media attachment IDs for featured images', async () => {
    const api = new FakeWordPressApi();
    const adapter = new WordPressAdapter(api, 'https://fake.example.com');

    const media = await adapter.uploadMedia({
      file: new Blob(['fake image'], { type: 'image/jpeg' }),
      filename: 'hero.jpg',
      mimeType: 'image/jpeg',
      alt: 'Hero',
    });

    const page = await adapter.createContent({
      kind: 'page',
      title: 'With hero',
      body: 'Body',
      status: 'draft',
      featureImage: media.url,
    });

    expect(api.uploadMediaCount).toBe(1);
    expect(api.pages.get(Number(page.id))?.featured_media).toBe(Number(media.id));
    expect(page.featureImage).toBe(media.url);
  });
});
