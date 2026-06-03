import { describe, it, expect, beforeEach } from 'vitest';
import { WebflowAdapter } from '../../src/webflow/adapter.js';
import { FakeWebflowApi } from '../fakes/FakeWebflowApi.js';
import { CmsApiError, ContentKind } from '../../src/cms/types.js';

const BLOG: ContentKind = 'webflow:blog-posts';
const GUIDES: ContentKind = 'webflow:guides';

describe('WebflowAdapter — collection-driven content kinds', () => {
  let api: FakeWebflowApi;
  let adapter: WebflowAdapter;

  beforeEach(() => {
    api = new FakeWebflowApi();
    api.seedDefaultCollection({ id: 'col_blog', displayName: 'Blog Posts', slug: 'blog-posts' });
    api.seedDefaultCollection({ id: 'col_guides', displayName: 'Guides', slug: 'guides' });
    adapter = new WebflowAdapter(api, 'site_fake');
  });

  it('listContentKinds returns one webflow:<slug> kind per collection', async () => {
    const kinds = await adapter.listContentKinds();
    expect(kinds).toEqual(expect.arrayContaining([BLOG, GUIDES]));
    expect(kinds).toHaveLength(2);
  });

  it('listContainers exposes the same collections as containers', async () => {
    const containers = await adapter.listContainers();
    expect(containers.map((c) => c.handle)).toEqual(expect.arrayContaining(['blog-posts', 'guides']));
  });

  it('createContent routes to the collection named by the kind', async () => {
    const created = await adapter.createContent({ kind: GUIDES, title: 'A guide', body: 'how-to' });
    expect(created.kind).toBe(GUIDES);
    expect(created.container?.handle).toBe('guides');
    // Composite id is prefixed with the guides collection id.
    expect(created.id.startsWith('col_guides:')).toBe(true);
  });

  it('listContent filtered by kind returns only that collection', async () => {
    await adapter.createContent({ kind: BLOG, title: 'Post 1', body: 'x' });
    await adapter.createContent({ kind: GUIDES, title: 'Guide 1', body: 'y' });

    const onlyGuides = await adapter.listContent({ kinds: [GUIDES] });
    expect(onlyGuides).toHaveLength(1);
    expect(onlyGuides[0].kind).toBe(GUIDES);
    expect(onlyGuides[0].title).toBe('Guide 1');

    const all = await adapter.listContent();
    expect(all).toHaveLength(2);
  });

  it('get/update/delete content round-trips by composite id', async () => {
    const created = await adapter.createContent({ kind: BLOG, title: 'Original', body: 'first' });

    const fetched = await adapter.getContent(BLOG, created.id);
    expect(fetched.title).toBe('Original');

    const updated = await adapter.updateContent(BLOG, created.id, { title: 'Renamed' });
    expect(updated.title).toBe('Renamed');

    await adapter.deleteContent(BLOG, created.id);
    try {
      await adapter.getContent(BLOG, created.id);
      throw new Error('expected getContent to throw after delete');
    } catch (err) {
      expect(err).toBeInstanceOf(CmsApiError);
      expect((err as CmsApiError).isNotFound()).toBe(true);
    }
  });

  it('createContent with an unknown kind throws unsupported_kind', async () => {
    try {
      await adapter.createContent({ kind: 'webflow:does-not-exist' as ContentKind, title: 'x', body: 'y' });
      throw new Error('expected createContent to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CmsApiError);
      expect((err as CmsApiError).message).toContain('does-not-exist');
    }
  });

  it('update merges fieldData — unspecified fields survive a title-only edit', async () => {
    const created = await adapter.createContent({
      kind: BLOG,
      title: 'Keepme',
      body: 'body text',
      tags: ['keep'],
    });
    const updated = await adapter.updateContent(BLOG, created.id, { title: 'New title' });
    expect(updated.title).toBe('New title');
    expect(updated.tags).toEqual(expect.arrayContaining(['keep']));
  });
});
