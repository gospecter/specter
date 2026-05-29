/**
 * Shared CmsAdapter contract test suite.
 *
 * Every adapter (Ghost, Shopify, WordPress, …) is required to pass the same
 * set of behavioral scenarios. Per-adapter test files (`ghost.contract.test.ts`,
 * `shopify.contract.test.ts`) call `runCmsAdapterContract(...)` and provide a
 * factory that returns a fresh adapter instance for each test.
 *
 * Capability flags gate scenarios that don't apply to every platform:
 *   - `optimisticLock`: platform supports server-side update-collision detection
 *     (Ghost: UPDATE_COLLISION; Shopify: no — last-writer-wins).
 *   - `containers`: 'flat' (Ghost — no blogs/categories) vs 'multi' (Shopify —
 *     articles belong to a blog).
 *
 * When WordPress lands, its contract test is ~10 lines: call this function
 * with a WordPress fake factory + caps. Any contract-level regression
 * surfaces immediately for every adapter.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { CmsAdapter } from '../../src/cms/adapter.js';
import { CmsApiError } from '../../src/cms/types.js';

export interface AdapterCapabilities {
  /** Platform supports optimistic-lock conflict on stale baseVersion. */
  optimisticLock: boolean;
  /** 'flat' = no container model (Ghost); 'multi' = container per post (Shopify). */
  containers: 'flat' | 'multi';
}

export function runCmsAdapterContract(
  label: string,
  makeAdapter: () => Promise<CmsAdapter>,
  caps: AdapterCapabilities,
): void {
  describe(`CmsAdapter contract — ${label}`, () => {
    let adapter: CmsAdapter;

    beforeEach(async () => {
      adapter = await makeAdapter();
    });

    // --- testConnection ---
    it('testConnection returns ok against a healthy backend', async () => {
      const r = await adapter.testConnection();
      expect(r.ok).toBe(true);
      expect(typeof r.message).toBe('string');
    });

    // --- create ---
    it('createPost returns a RemotePost with id, slug, title, body', async () => {
      const remote = await adapter.createPost({
        title: 'Contract test post',
        body: 'Hello **world** with `code`.',
        status: 'draft',
      });
      expect(remote.id).toBeTruthy();
      expect(remote.slug).toBeTruthy();
      expect(remote.title).toBe('Contract test post');
      // Body is markdown — adapters do HTML↔md at the seam. We don't assert
      // byte-equality (platforms normalize); we assert meaningful tokens survive.
      expect(remote.body).toContain('world');
    });

    it('createPost honors status (draft and published round-trip)', async () => {
      const draft = await adapter.createPost({
        title: 'Draft post',
        body: 'x',
        status: 'draft',
      });
      expect(draft.status).toBe('draft');

      const published = await adapter.createPost({
        title: 'Published post',
        body: 'x',
        status: 'published',
      });
      expect(published.status).toBe('published');
    });

    it('createPost preserves tags', async () => {
      const remote = await adapter.createPost({
        title: 'Tagged',
        body: 'x',
        tags: ['contract', 'test'],
      });
      expect(remote.tags).toEqual(expect.arrayContaining(['contract', 'test']));
    });

    // --- list ---
    it('listPosts after createPost includes the new post', async () => {
      const created = await adapter.createPost({ title: 'Listed', body: 'x' });
      const all = await adapter.listPosts();
      const found = all.find((p) => p.id === created.id);
      expect(found).toBeDefined();
      expect(found?.title).toBe('Listed');
    });

    it('listPosts honors includeDrafts=false', async () => {
      await adapter.createPost({ title: 'Pub', body: 'x', status: 'published' });
      await adapter.createPost({ title: 'Drft', body: 'x', status: 'draft' });
      const onlyPublished = await adapter.listPosts({
        includeDrafts: false,
        includePublished: true,
      });
      expect(onlyPublished.every((p) => p.status === 'published')).toBe(true);
    });

    // --- read ---
    it('getPost returns the post by id', async () => {
      const created = await adapter.createPost({ title: 'Readable', body: 'x' });
      const fetched = await adapter.getPost(created.id);
      expect(fetched.id).toBe(created.id);
      expect(fetched.title).toBe('Readable');
    });

    it('getPost on a deleted id throws CmsApiError.isNotFound()', async () => {
      const created = await adapter.createPost({ title: 'Doomed', body: 'x' });
      await adapter.deletePost(created.id);
      try {
        await adapter.getPost(created.id);
        throw new Error('expected getPost to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(CmsApiError);
        expect((err as CmsApiError).isNotFound()).toBe(true);
      }
    });

    // --- update ---
    it('updatePost changes the title', async () => {
      const created = await adapter.createPost({ title: 'Original', body: 'x' });
      const updated = await adapter.updatePost(created.id, { title: 'Renamed' });
      expect(updated.title).toBe('Renamed');
    });

    it('updatePost changes the body', async () => {
      const created = await adapter.createPost({ title: 'T', body: 'first version' });
      const updated = await adapter.updatePost(created.id, { body: 'second **version**' });
      expect(updated.body).toContain('second');
    });

    it('updatePost partial fields leave other fields intact', async () => {
      const created = await adapter.createPost({
        title: 'Stable',
        body: 'body text',
        tags: ['keep'],
      });
      const updated = await adapter.updatePost(created.id, { title: 'New title' });
      expect(updated.title).toBe('New title');
      expect(updated.tags).toEqual(expect.arrayContaining(['keep']));
    });

    // --- delete ---
    it('deletePost removes the post (subsequent getPost throws)', async () => {
      const created = await adapter.createPost({ title: 'Trash me', body: 'x' });
      await adapter.deletePost(created.id);
      try {
        await adapter.getPost(created.id);
        throw new Error('expected getPost to throw after delete');
      } catch (err) {
        expect(err).toBeInstanceOf(CmsApiError);
        expect((err as CmsApiError).isNotFound()).toBe(true);
      }
    });

    // --- containers (capability-gated) ---
    if (caps.containers === 'flat') {
      it('listContainers returns [] on flat platforms', async () => {
        const containers = await adapter.listContainers();
        expect(containers).toEqual([]);
      });

      it('createPost succeeds without containerHandle on flat platforms', async () => {
        const remote = await adapter.createPost({ title: 'Flat', body: 'x' });
        expect(remote.container).toBeNull();
      });
    }

    if (caps.containers === 'multi') {
      it('listContainers returns >= 1 container on multi-container platforms', async () => {
        const containers = await adapter.listContainers();
        expect(containers.length).toBeGreaterThanOrEqual(1);
        expect(containers[0]).toMatchObject({
          id: expect.any(String),
          handle: expect.any(String),
          title: expect.any(String),
        });
      });

      it('createPost defaults to the first container when handle omitted', async () => {
        const containers = await adapter.listContainers();
        const remote = await adapter.createPost({ title: 'Defaulted', body: 'x' });
        expect(remote.container?.handle).toBe(containers[0].handle);
      });

      it('createPost throws CmsApiError on unknown containerHandle', async () => {
        try {
          await adapter.createPost({
            title: 'Bad container',
            body: 'x',
            containerHandle: 'this-container-does-not-exist',
          });
          throw new Error('expected createPost to throw');
        } catch (err) {
          expect(err).toBeInstanceOf(CmsApiError);
        }
      });
    }

    // --- optimistic lock (capability-gated) ---
    if (caps.optimisticLock) {
      it('updatePost with stale baseVersion throws CmsApiError.isConflict()', async () => {
        const created = await adapter.createPost({ title: 'Lockable', body: 'first' });
        const stale = { updatedAt: created.updatedAt };
        // First update succeeds and advances updatedAt server-side.
        await adapter.updatePost(created.id, { body: 'second' });
        // Second update with the original (now-stale) baseVersion must conflict.
        try {
          await adapter.updatePost(created.id, { body: 'third' }, stale);
          throw new Error('expected updatePost to throw on stale baseVersion');
        } catch (err) {
          expect(err).toBeInstanceOf(CmsApiError);
          expect((err as CmsApiError).isConflict()).toBe(true);
        }
      });
    }
  });
}
