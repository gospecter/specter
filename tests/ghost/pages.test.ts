import { describe, expect, it } from 'vitest';
import { FakeGhostApi } from '../fakes/FakeGhostApi.js';

describe('Ghost pages content API', () => {
  it('lists posts and pages as distinct content kinds', async () => {
    const adapter = new FakeGhostApi().adapter();
    const post = await adapter.createContent({
      kind: 'post',
      title: 'A post',
      body: 'Post body',
    });
    const page = await adapter.createContent({
      kind: 'page',
      title: 'A page',
      body: 'Page body',
    });

    const all = await adapter.listContent();

    expect(all).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: post.id, kind: 'post', title: 'A post' }),
        expect.objectContaining({ id: page.id, kind: 'page', title: 'A page' }),
      ]),
    );
  });

  it('creates, reads, updates, and deletes a page', async () => {
    const adapter = new FakeGhostApi().adapter();

    const created = await adapter.createContent({
      kind: 'page',
      title: 'About',
      body: 'First version',
      status: 'draft',
      tags: ['company'],
    });
    expect(created.kind).toBe('page');
    expect(created.status).toBe('draft');
    expect(created.tags).toEqual(expect.arrayContaining(['company']));

    const fetched = await adapter.getContent('page', created.id);
    expect(fetched.body).toContain('First version');

    const updated = await adapter.updateContent(
      'page',
      created.id,
      { body: 'Second version', status: 'published' },
      { updatedAt: fetched.updatedAt },
    );
    expect(updated.kind).toBe('page');
    expect(updated.body).toContain('Second version');
    expect(updated.status).toBe('published');

    await adapter.deleteContent('page', created.id);
    await expect(adapter.getContent('page', created.id)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('uploads media through the Ghost image endpoint', async () => {
    const api = new FakeGhostApi();
    const adapter = api.adapter();

    const media = await adapter.uploadMedia({
      file: new Blob(['fake-image-bytes'], { type: 'image/png' }),
      filename: 'cover.png',
      mimeType: 'image/png',
      alt: 'Cover',
      ref: 'local-assets/cover.png',
      purpose: 'image',
    });

    expect(api.uploadImageCount).toBe(1);
    expect(media).toEqual({
      id: 'local-assets/cover.png',
      url: 'https://fake.invalid/content/images/cover.png',
      alt: 'Cover',
      filename: 'cover.png',
      mimeType: 'image/png',
      platform: 'ghost',
    });
  });
});
