import { afterEach, describe, expect, it, vi } from 'vitest';
import { GhostApiClient } from '../../src/ghost/api.js';

describe('GhostApiClient media upload', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts multipart form-data without forcing JSON content-type', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          images: [{ url: 'https://example.test/content/images/cover.png', ref: 'asset/cover.png' }],
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const api = new GhostApiClient(
      'https://example.test',
      'keyid:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    );

    const image = await api.uploadImage({
      file: new Blob(['fake'], { type: 'image/png' }),
      filename: 'cover.png',
      ref: 'asset/cover.png',
      purpose: 'image',
    });

    expect(image.url).toBe('https://example.test/content/images/cover.png');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/ghost/api/admin/images/upload/');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);

    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Ghost /);
    expect(headers['Accept-Version']).toBe('v5.0');
    expect(headers['Content-Type']).toBeUndefined();
  });
});
