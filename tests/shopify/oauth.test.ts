import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  refreshShopifyAccessToken,
  shopifyTokenNeedsRefresh,
} from '../../src/shopify/oauth.js';

describe('Shopify OAuth token refresh', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('refreshes and rotates access + refresh tokens through the Specter endpoint', async () => {
    vi.stubEnv('SPECTER_SHOPIFY_REFRESH_URL', 'https://example.test/refresh');
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        accessTokenExpiresAt: '2026-05-28T12:00:00.000Z',
        refreshTokenExpiresAt: '2026-08-26T12:00:00.000Z',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const refreshed = await refreshShopifyAccessToken({
      platform: 'shopify',
      shop: 'specter-test.myshopify.com',
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      apiVersion: '2026-01',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.test/refresh',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          shop: 'specter-test.myshopify.com',
          refreshToken: 'old-refresh',
        }),
      }),
    );
    expect(refreshed).toMatchObject({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      accessTokenExpiresAt: '2026-05-28T12:00:00.000Z',
      refreshTokenExpiresAt: '2026-08-26T12:00:00.000Z',
      apiVersion: '2026-01',
    });
  });

  it('pre-refreshes tokens that expire within five minutes', () => {
    const soon = new Date(Date.now() + 60_000).toISOString();
    const later = new Date(Date.now() + 10 * 60_000).toISOString();

    expect(shopifyTokenNeedsRefresh({
      platform: 'shopify',
      shop: 'specter-test.myshopify.com',
      accessToken: 'access',
      refreshToken: 'refresh',
      accessTokenExpiresAt: soon,
    })).toBe(true);
    expect(shopifyTokenNeedsRefresh({
      platform: 'shopify',
      shop: 'specter-test.myshopify.com',
      accessToken: 'access',
      refreshToken: 'refresh',
      accessTokenExpiresAt: later,
    })).toBe(false);
  });
});
