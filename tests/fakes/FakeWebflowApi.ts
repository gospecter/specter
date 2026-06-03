/**
 * In-memory Webflow Data API stand-in for tests.
 *
 * Extends `WebflowApiClient` so it satisfies `WebflowAdapter`'s constructor
 * (typed against the real class). Every method the adapter calls is overridden,
 * so `super.*` (which throws NOT_IMPLEMENTED in Phase 1) is never invoked and no
 * real HTTP request is made. Mirrors the FakeShopifyApi/FakeGhostApi pattern.
 */

import {
  WebflowApiClient,
  WebflowCollection,
  WebflowField,
  WebflowItem,
  WebflowItemInput,
} from '../../src/webflow/api.js';
import { CmsApiError } from '../../src/cms/types.js';

let idSeq = 5000;
const nextItemId = () => `wf_item_${++idSeq}`;

const DEFAULT_FIELDS: WebflowField[] = [
  { slug: 'name', displayName: 'Name', type: 'PlainText' },
  { slug: 'slug', displayName: 'Slug', type: 'PlainText' },
  { slug: 'body', displayName: 'Body', type: 'RichText' },
  { slug: 'tags', displayName: 'Tags', type: 'Option' },
];

export function makeWebflowCollection(
  overrides: Partial<WebflowCollection> = {},
): WebflowCollection {
  return {
    id: overrides.id ?? 'col_blog',
    displayName: overrides.displayName ?? 'Blog Posts',
    slug: overrides.slug ?? 'blog-posts',
    fields: overrides.fields ?? DEFAULT_FIELDS,
  };
}

export class FakeWebflowApi extends WebflowApiClient {
  collectionsArr: WebflowCollection[] = [];
  /** itemId → { collectionId, item }. */
  private store = new Map<string, { collectionId: string; item: WebflowItem }>();

  public createCount = 0;
  public updateCount = 0;
  public deleteCount = 0;
  public listCollectionsCount = 0;

  constructor() {
    super('site_fake', 'token_fake');
  }

  seedDefaultCollection(overrides: Partial<WebflowCollection> = {}): WebflowCollection {
    const collection = makeWebflowCollection(overrides);
    this.collectionsArr.push(collection);
    return collection;
  }

  override async testConnection(): Promise<{ success: boolean; message: string }> {
    return { success: true, message: 'Connected to Webflow site site_fake' };
  }

  override async listCollections(): Promise<WebflowCollection[]> {
    this.listCollectionsCount++;
    return [...this.collectionsArr];
  }

  override async getCollection(collectionId: string): Promise<WebflowCollection> {
    const c = this.collectionsArr.find((x) => x.id === collectionId);
    if (!c) throw new CmsApiError(`Collection ${collectionId} not found`, 404, 'not_found', 'webflow');
    return c;
  }

  override async listItems(collectionId: string): Promise<WebflowItem[]> {
    return Array.from(this.store.values())
      .filter((e) => e.collectionId === collectionId)
      .map((e) => e.item);
  }

  override async getItem(collectionId: string, itemId: string): Promise<WebflowItem> {
    const e = this.store.get(itemId);
    if (!e || e.collectionId !== collectionId) {
      throw new CmsApiError(`Item ${itemId} not found`, 404, 'not_found', 'webflow');
    }
    return e.item;
  }

  override async createItem(collectionId: string, input: WebflowItemInput): Promise<WebflowItem> {
    this.createCount++;
    if (!this.collectionsArr.some((c) => c.id === collectionId)) {
      throw new CmsApiError(`Collection ${collectionId} not found`, 404, 'not_found', 'webflow');
    }
    const now = new Date().toISOString();
    const item: WebflowItem = {
      id: nextItemId(),
      isDraft: input.isDraft ?? false,
      isArchived: input.isArchived ?? false,
      lastUpdated: now,
      createdOn: now,
      lastPublished: null,
      fieldData: { ...input.fieldData },
    };
    this.store.set(item.id, { collectionId, item });
    return item;
  }

  override async updateItem(
    collectionId: string,
    itemId: string,
    input: WebflowItemInput,
  ): Promise<WebflowItem> {
    this.updateCount++;
    const e = this.store.get(itemId);
    if (!e || e.collectionId !== collectionId) {
      throw new CmsApiError(`Item ${itemId} not found`, 404, 'not_found', 'webflow');
    }
    // Webflow merges fieldData on PATCH — keep unspecified fields intact.
    const merged: WebflowItem = {
      ...e.item,
      isDraft: input.isDraft ?? e.item.isDraft,
      isArchived: input.isArchived ?? e.item.isArchived,
      fieldData: { ...e.item.fieldData, ...input.fieldData },
      lastUpdated: new Date().toISOString(),
    };
    e.item = merged;
    return merged;
  }

  override async deleteItem(collectionId: string, itemId: string): Promise<void> {
    this.deleteCount++;
    const e = this.store.get(itemId);
    if (!e || e.collectionId !== collectionId) {
      throw new CmsApiError(`Item ${itemId} not found`, 404, 'not_found', 'webflow');
    }
    this.store.delete(itemId);
  }
}
