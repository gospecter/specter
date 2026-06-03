/**
 * Webflow Data API v2 client.
 *
 * Auth: `Authorization: Bearer <token>` — the token is either a Site API
 * token (AGPL/DIY, pasted by the user) or an OAuth access token (PRO, issued
 * by the hosted flow). Both are identical on the wire, so this client never
 * branches on which produced the token.
 *
 * Data model (drives the adapter's container/field mapping):
 *  - A *site* owns many *collections* (the multi-container unit). The site
 *    `GET …/collections` list returns summaries only; the per-collection
 *    `GET /collections/{id}` call carries the field schema, so `listCollections`
 *    enriches each summary with a details fetch (the adapter caches the result).
 *  - A *collection* has a field schema; every collection is guaranteed a
 *    `name` and a `slug` field. Rich-text fields carry HTML.
 *  - A collection *item* has a stable `id`, draft/archived flags, timestamps,
 *    and a `fieldData` map keyed by field slug. PATCH merges `fieldData`.
 *
 * Status model: items are draft/published via `isDraft` (publishing is a
 * separate site-level action). There is no native 'scheduled' state, and no
 * optimistic-lock / collision detection — the engine does read-then-write
 * (capability `optimisticLock: false`).
 *
 * Rate limits: 60/min (Starter/Basic) or 120/min (CMS/eComm/Business). On 429
 * the `Retry-After` header (seconds) is surfaced as `CmsApiError.retryAfterMs`.
 */

import { CmsApiError } from '../cms/types.js';

export const WEBFLOW_API_BASE = 'https://api.webflow.com/v2';

/** One field in a collection's schema. `type` is Webflow's field type, e.g.
 *  'PlainText' | 'RichText' | 'Image' | 'Option' | 'MultiReference'. */
export interface WebflowField {
  slug: string;
  displayName: string;
  type: string;
}

export interface WebflowCollection {
  id: string;
  displayName: string;
  slug: string;
  fields: WebflowField[];
}

export interface WebflowItem {
  /** Stable, immutable item id (the sync identity, namespaced by collection). */
  id: string;
  isDraft: boolean;
  isArchived: boolean;
  /** ISO 8601. */
  lastUpdated: string;
  /** ISO 8601. */
  createdOn: string;
  /** ISO 8601, or null if never published. */
  lastPublished: string | null;
  /** Custom field values, keyed by field slug. Includes `name` and `slug`. */
  fieldData: Record<string, unknown>;
}

export interface WebflowItemInput {
  isDraft?: boolean;
  isArchived?: boolean;
  /** Partial on update — only the provided field slugs are written; Webflow
   *  merges the rest. */
  fieldData: Record<string, unknown>;
}

/** Raw item as the wire returns it (timestamps may be absent on fresh creates). */
interface RawItem {
  id: string;
  isDraft?: boolean;
  isArchived?: boolean;
  lastUpdated?: string | null;
  createdOn?: string | null;
  lastPublished?: string | null;
  fieldData?: Record<string, unknown>;
}

interface RawCollectionSummary {
  id: string;
  displayName: string;
  slug: string;
}

interface RawField {
  slug: string;
  displayName: string;
  type: string;
}

interface RawCollectionDetails extends RawCollectionSummary {
  fields?: RawField[];
}

/** Parse `Retry-After` (seconds-as-int or HTTP-date) into milliseconds. */
function parseRetryAfter(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const asInt = Number(raw);
  if (Number.isFinite(asInt)) return Math.max(0, asInt * 1000);
  const asDate = Date.parse(raw);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return undefined;
}

function normalizeItem(raw: RawItem): WebflowItem {
  return {
    id: raw.id,
    isDraft: raw.isDraft ?? false,
    isArchived: raw.isArchived ?? false,
    lastUpdated: raw.lastUpdated ?? raw.createdOn ?? new Date().toISOString(),
    createdOn: raw.createdOn ?? raw.lastUpdated ?? new Date().toISOString(),
    lastPublished: raw.lastPublished ?? null,
    fieldData: raw.fieldData ?? {},
  };
}

export class WebflowApiClient {
  protected readonly baseUrl: string;

  constructor(
    protected readonly siteId: string,
    protected readonly token: string,
    baseUrl: string = WEBFLOW_API_BASE,
  ) {
    this.baseUrl = baseUrl;
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      const collections = await this.listCollections();
      return {
        success: true,
        message: `Connected to Webflow site ${this.siteId} (${collections.length} collection${collections.length === 1 ? '' : 's'})`,
      };
    } catch (err) {
      if (err instanceof CmsApiError) {
        return { success: false, message: err.message };
      }
      throw err;
    }
  }

  async listCollections(): Promise<WebflowCollection[]> {
    const res = await this.request<{ collections?: RawCollectionSummary[] }>(
      'GET',
      `/sites/${encodeURIComponent(this.siteId)}/collections`,
    );
    const summaries = res.collections ?? [];
    // The list endpoint omits field schemas; fetch each collection's details so
    // the adapter can resolve field mappings. The adapter caches the result, so
    // this fan-out happens at most once per process.
    return Promise.all(summaries.map((s) => this.getCollection(s.id)));
  }

  async getCollection(collectionId: string): Promise<WebflowCollection> {
    const raw = await this.request<RawCollectionDetails>(
      'GET',
      `/collections/${encodeURIComponent(collectionId)}`,
    );
    return {
      id: raw.id,
      displayName: raw.displayName,
      slug: raw.slug,
      fields: (raw.fields ?? []).map((f) => ({
        slug: f.slug,
        displayName: f.displayName,
        type: f.type,
      })),
    };
  }

  async listItems(collectionId: string): Promise<WebflowItem[]> {
    const limit = 100;
    const all: WebflowItem[] = [];
    let offset = 0;
    // Paginate until we've seen `total` items (or a short page signals the end).
    for (;;) {
      const res = await this.request<{
        items?: RawItem[];
        pagination?: { limit: number; offset: number; total: number };
      }>(
        'GET',
        `/collections/${encodeURIComponent(collectionId)}/items?limit=${limit}&offset=${offset}`,
      );
      const items = res.items ?? [];
      all.push(...items.map(normalizeItem));
      const total = res.pagination?.total ?? all.length;
      offset += limit;
      if (items.length < limit || offset >= total) break;
    }
    return all;
  }

  async getItem(collectionId: string, itemId: string): Promise<WebflowItem> {
    const raw = await this.request<RawItem>(
      'GET',
      `/collections/${encodeURIComponent(collectionId)}/items/${encodeURIComponent(itemId)}`,
    );
    return normalizeItem(raw);
  }

  async createItem(collectionId: string, input: WebflowItemInput): Promise<WebflowItem> {
    const raw = await this.request<RawItem>(
      'POST',
      `/collections/${encodeURIComponent(collectionId)}/items`,
      {
        isDraft: input.isDraft ?? false,
        isArchived: input.isArchived ?? false,
        fieldData: input.fieldData,
      },
    );
    return normalizeItem(raw);
  }

  async updateItem(
    collectionId: string,
    itemId: string,
    input: WebflowItemInput,
  ): Promise<WebflowItem> {
    const body: Record<string, unknown> = { fieldData: input.fieldData };
    if (input.isDraft !== undefined) body.isDraft = input.isDraft;
    if (input.isArchived !== undefined) body.isArchived = input.isArchived;
    const raw = await this.request<RawItem>(
      'PATCH',
      `/collections/${encodeURIComponent(collectionId)}/items/${encodeURIComponent(itemId)}`,
      body,
    );
    return normalizeItem(raw);
  }

  async deleteItem(collectionId: string, itemId: string): Promise<void> {
    await this.request<void>(
      'DELETE',
      `/collections/${encodeURIComponent(collectionId)}/items/${encodeURIComponent(itemId)}`,
    );
  }

  /** Issue an authenticated request and map non-2xx responses to CmsApiError. */
  protected async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      throw await this.toError(res);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private async toError(res: Response): Promise<CmsApiError> {
    let message = `Webflow API error ${res.status}`;
    try {
      const data = (await res.json()) as { message?: string; code?: string };
      if (data?.message) message = data.message;
    } catch {
      // non-JSON body — keep the default message
    }
    const errorType =
      res.status === 429
        ? 'rate_limited'
        : res.status === 404
          ? 'not_found'
          : undefined;
    const retryAfterMs =
      res.status === 429 ? parseRetryAfter(res.headers.get('Retry-After')) : undefined;
    return new CmsApiError(message, res.status, errorType, 'webflow', retryAfterMs);
  }
}
