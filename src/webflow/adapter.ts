/**
 * Webflow implementation of CmsAdapter.
 *
 * Composes WebflowApiClient + mapping. For Webflow, **a CMS collection is
 * simultaneously the container and the content kind**: `listContainers()`
 * returns one container per collection, and the kind-aware content API keys on
 * `webflow:<collectionSlug>`. `containers: 'multi'`.
 *
 * Webflow has no optimistic lock, so `baseVersion` is ignored and the engine
 * performs read-then-write conflict detection.
 *
 * The collection list (with field schemas) is cached on the adapter so we
 * don't refetch it for every item mapping; `fieldMap` supplies per-collection
 * field overrides keyed by collection id.
 */

import { CmsAdapter } from '../cms/adapter.js';
import {
  CmsApiError,
  ContentKind,
  CreateContentInput,
  CreatePostInput,
  ListOptions,
  Platform,
  RemoteContainer,
  RemoteContentItem,
  RemotePost,
  UpdateContentInput,
  UpdatePostInput,
} from '../cms/types.js';
import { WebflowApiClient, WebflowCollection } from './api.js';
import {
  FieldMapOverride,
  collectionKind,
  collectionToContainer,
  createInputToWebflow,
  itemToRemotePost,
  kindToSlug,
  parseCompositeId,
  resolveFieldMapping,
  updateInputToWebflow,
} from './mapping.js';

export class WebflowAdapter implements CmsAdapter {
  readonly platform: Platform = 'webflow';

  private collectionsCache: WebflowCollection[] | null = null;

  constructor(
    private api: WebflowApiClient,
    private siteId: string,
    private fieldMap: Record<string, FieldMapOverride> = {},
  ) {}

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    const r = await this.api.testConnection();
    return { ok: r.success, message: r.message };
  }

  async listContainers(): Promise<RemoteContainer[]> {
    return (await this.collections()).map(collectionToContainer);
  }

  // --- legacy post API (kind-agnostic; spans all collections) ---

  async listPosts(options?: ListOptions): Promise<RemotePost[]> {
    return this.listContent(options);
  }

  async getPost(id: string): Promise<RemotePost> {
    const collection = await this.resolveCollectionForId(id);
    return this.fetchMapped(collection, parseCompositeId(id).itemId);
  }

  async createPost(input: CreatePostInput): Promise<RemotePost> {
    const collection = await this.pickContainer(input.containerHandle);
    return this.createMapped(collection, input);
  }

  async updatePost(id: string, input: UpdatePostInput): Promise<RemotePost> {
    const collection = await this.resolveCollectionForId(id);
    return this.updateMapped(collection, parseCompositeId(id).itemId, input);
  }

  async deletePost(id: string): Promise<void> {
    const collection = await this.resolveCollectionForId(id);
    await this.api.deleteItem(collection.id, parseCompositeId(id).itemId);
  }

  // --- kind-aware content API (kind === `webflow:<collectionSlug>`) ---

  async listContent(options?: ListOptions): Promise<RemoteContentItem[]> {
    const wantDraft = options?.includeDrafts !== false;
    const wantPublished = options?.includePublished !== false;
    const collections = await this.selectedCollections(options?.kinds);
    const batches = await Promise.all(
      collections.map(async (collection) => {
        const mapping = resolveFieldMapping(collection, this.fieldMap[collection.id]);
        const items = await this.api.listItems(collection.id);
        return items
          .filter((item) => (item.isDraft ? wantDraft : wantPublished))
          .map((item) => itemToRemotePost(collection, mapping, item));
      }),
    );
    return batches.flat();
  }

  async getContent(kind: ContentKind, id: string): Promise<RemoteContentItem> {
    const collection = await this.collectionForIdOrKind(id, kind);
    return this.fetchMapped(collection, parseCompositeId(id).itemId);
  }

  async createContent(input: CreateContentInput): Promise<RemoteContentItem> {
    const collection = input.containerHandle
      ? await this.pickContainer(input.containerHandle)
      : await this.collectionByKind(input.kind);
    return this.createMapped(collection, input);
  }

  async updateContent(
    kind: ContentKind,
    id: string,
    input: UpdateContentInput,
    _baseVersion?: { updatedAt: string },
  ): Promise<RemoteContentItem> {
    const collection = await this.collectionForIdOrKind(id, kind);
    return this.updateMapped(collection, parseCompositeId(id).itemId, input);
  }

  async deleteContent(kind: ContentKind, id: string): Promise<void> {
    const collection = await this.collectionForIdOrKind(id, kind);
    await this.api.deleteItem(collection.id, parseCompositeId(id).itemId);
  }

  /** Enumerate the content kinds this site exposes — one per CMS collection.
   *  Used by the connect flow to offer kinds for selection. */
  async listContentKinds(): Promise<ContentKind[]> {
    return (await this.collections()).map(collectionKind);
  }

  // --- shared mapping core ---

  private async fetchMapped(collection: WebflowCollection, itemId: string): Promise<RemoteContentItem> {
    const mapping = resolveFieldMapping(collection, this.fieldMap[collection.id]);
    return itemToRemotePost(collection, mapping, await this.api.getItem(collection.id, itemId));
  }

  private async createMapped(
    collection: WebflowCollection,
    input: CreatePostInput,
  ): Promise<RemoteContentItem> {
    const mapping = resolveFieldMapping(collection, this.fieldMap[collection.id]);
    const item = await this.api.createItem(collection.id, createInputToWebflow(mapping, input));
    return itemToRemotePost(collection, mapping, item);
  }

  private async updateMapped(
    collection: WebflowCollection,
    itemId: string,
    input: UpdatePostInput,
  ): Promise<RemoteContentItem> {
    // Webflow has no optimistic lock — baseVersion is intentionally ignored.
    const mapping = resolveFieldMapping(collection, this.fieldMap[collection.id]);
    const item = await this.api.updateItem(collection.id, itemId, updateInputToWebflow(mapping, input));
    return itemToRemotePost(collection, mapping, item);
  }

  // --- collection resolution ---

  private async collections(): Promise<WebflowCollection[]> {
    if (!this.collectionsCache) {
      this.collectionsCache = await this.api.listCollections();
    }
    return this.collectionsCache;
  }

  private async selectedCollections(kinds?: ContentKind[]): Promise<WebflowCollection[]> {
    const all = await this.collections();
    if (!kinds || kinds.length === 0) return all;
    const slugs = new Set(kinds.map(kindToSlug));
    return all.filter((c) => slugs.has(c.slug));
  }

  private async collectionById(collectionId: string): Promise<WebflowCollection> {
    const found = (await this.collections()).find((c) => c.id === collectionId);
    if (!found) {
      throw new CmsApiError(
        `Webflow collection "${collectionId}" not found on site ${this.siteId}`,
        404,
        'not_found',
        'webflow',
      );
    }
    return found;
  }

  private async collectionByKind(kind: ContentKind): Promise<WebflowCollection> {
    const slug = kindToSlug(kind);
    const found = (await this.collections()).find((c) => c.slug === slug);
    if (!found) {
      throw new CmsApiError(
        `Webflow content kind "${kind}" has no matching collection on site ${this.siteId}`,
        400,
        'unsupported_kind',
        'webflow',
      );
    }
    return found;
  }

  /** Prefer the collection encoded in the composite id (authoritative); fall
   *  back to the kind when the id is bare (legacy/hand-written frontmatter). */
  private async collectionForIdOrKind(id: string, kind: ContentKind): Promise<WebflowCollection> {
    const { collectionId } = parseCompositeId(id);
    return collectionId ? this.collectionById(collectionId) : this.collectionByKind(kind);
  }

  private async resolveCollectionForId(id: string): Promise<WebflowCollection> {
    const { collectionId } = parseCompositeId(id);
    if (collectionId) return this.collectionById(collectionId);
    throw new CmsApiError(
      `Webflow id "${id}" is missing its collection prefix; cannot resolve the item`,
      400,
      'bad_id',
      'webflow',
    );
  }

  /** Choose the target collection for a create — by handle, or the first. */
  private async pickContainer(handle?: string): Promise<WebflowCollection> {
    const collections = await this.collections();
    if (collections.length === 0) {
      throw new CmsApiError(
        `Webflow site ${this.siteId} has no CMS collections to write to`,
        400,
        'no_collections',
        'webflow',
      );
    }
    if (!handle) return collections[0];
    const found = collections.find((c) => c.slug === handle);
    if (!found) {
      throw new CmsApiError(
        `Webflow collection with handle "${handle}" not found`,
        404,
        'not_found',
        'webflow',
      );
    }
    return found;
  }
}
