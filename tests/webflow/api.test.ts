import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebflowApiClient } from '../../src/webflow/api.js';
import { CmsApiError } from '../../src/cms/types.js';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const COLLECTION = {
  id: 'col_1',
  displayName: 'Blog',
  slug: 'blog',
  fields: [
    { slug: 'name', displayName: 'Name', type: 'PlainText' },
    { slug: 'slug', displayName: 'Slug', type: 'PlainText' },
    { slug: 'body', displayName: 'Body', type: 'RichText' },
  ],
};

function rawItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item_1',
    isDraft: false,
    isArchived: false,
    lastUpdated: '2026-01-02T00:00:00.000Z',
    createdOn: '2026-01-01T00:00:00.000Z',
    lastPublished: null,
    fieldData: { name: 'Hello', slug: 'hello', body: '<p>Hi</p>' },
    ...overrides,
  };
}

describe('WebflowApiClient', () => {
  let client: WebflowApiClient;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = new WebflowApiClient('site_123', 'tok_abc');
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('listCollections hits the site endpoint with Bearer auth, then enriches each with details', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ collections: [{ id: 'col_1', displayName: 'Blog', slug: 'blog' }] }))
      .mockResolvedValueOnce(jsonResponse(COLLECTION));

    const cols = await client.listCollections();

    const [listUrl, listInit] = fetchSpy.mock.calls[0];
    expect(listUrl).toBe('https://api.webflow.com/v2/sites/site_123/collections');
    expect((listInit as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok_abc' });
    expect(fetchSpy.mock.calls[1][0]).toBe('https://api.webflow.com/v2/collections/col_1');
    expect(cols[0].fields.find((f) => f.type === 'RichText')?.slug).toBe('body');
  });

  it('listItems paginates until total is reached', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => rawItem({ id: `i${i}` }));
    const page2 = [rawItem({ id: 'i100' })];
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ items: page1, pagination: { limit: 100, offset: 0, total: 101 } }))
      .mockResolvedValueOnce(jsonResponse({ items: page2, pagination: { limit: 100, offset: 100, total: 101 } }));

    const items = await client.listItems('col_1');

    expect(items).toHaveLength(101);
    expect(fetchSpy.mock.calls[0][0]).toContain('/collections/col_1/items?limit=100&offset=0');
    expect(fetchSpy.mock.calls[1][0]).toContain('offset=100');
  });

  it('createItem POSTs fieldData + isDraft and normalizes the response', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(rawItem(), 202));

    const item = await client.createItem('col_1', {
      isDraft: true,
      fieldData: { name: 'Hello', slug: 'hello' },
    });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.webflow.com/v2/collections/col_1/items');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      isDraft: true,
      isArchived: false,
      fieldData: { name: 'Hello', slug: 'hello' },
    });
    expect(item.id).toBe('item_1');
  });

  it('updateItem PATCHes and omits isDraft when not provided', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(rawItem()));

    await client.updateItem('col_1', 'item_1', { fieldData: { name: 'New' } });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.webflow.com/v2/collections/col_1/items/item_1');
    expect((init as RequestInit).method).toBe('PATCH');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ fieldData: { name: 'New' } });
    expect(body).not.toHaveProperty('isDraft');
  });

  it('deleteItem issues DELETE and tolerates a 204 (no body)', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(client.deleteItem('col_1', 'item_1')).resolves.toBeUndefined();
    expect((fetchSpy.mock.calls[0][1] as RequestInit).method).toBe('DELETE');
  });

  it('maps 404 to CmsApiError.isNotFound()', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ message: 'Item not found' }, 404));
    try {
      await client.getItem('col_1', 'missing');
      throw new Error('expected getItem to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CmsApiError);
      expect((err as CmsApiError).isNotFound()).toBe(true);
      expect((err as CmsApiError).message).toBe('Item not found');
    }
  });

  it('maps 429 to isRateLimited() and surfaces Retry-After as retryAfterMs', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ message: 'Too many requests' }, 429, { 'Retry-After': '30' }),
    );
    try {
      await client.getItem('col_1', 'item_1');
      throw new Error('expected getItem to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CmsApiError);
      expect((err as CmsApiError).isRateLimited()).toBe(true);
      expect((err as CmsApiError).retryAfterMs).toBe(30000);
    }
  });

  it('testConnection returns success on 200 and a message on failure', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ collections: [] }));
    const ok = await client.testConnection();
    expect(ok.success).toBe(true);
    expect(ok.message).toContain('0 collections');

    fetchSpy.mockResolvedValueOnce(jsonResponse({ message: 'Unauthorized' }, 401));
    const bad = await client.testConnection();
    expect(bad.success).toBe(false);
    expect(bad.message).toBe('Unauthorized');
  });
});
