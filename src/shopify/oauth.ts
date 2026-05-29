import { AdapterConfig } from '../cms/types.js';

type ShopifyAdapterConfig = Extract<AdapterConfig, { platform: 'shopify' }>;

export interface ShopifyRefreshResponse {
  accessToken: string;
  refreshToken: string;
  scope?: string;
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
}

const DEFAULT_REFRESH_ENDPOINT = 'https://spectersync.com/api/oauth/shopify/refresh';

export async function refreshShopifyAccessToken(
  adapter: ShopifyAdapterConfig,
): Promise<ShopifyAdapterConfig> {
  if (!adapter.refreshToken) {
    throw new Error('Shopify token expired and no refresh token is saved. Reconnect Shopify.');
  }

  const endpoint = process.env.SPECTER_SHOPIFY_REFRESH_URL ?? DEFAULT_REFRESH_ENDPOINT;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      shop: adapter.shop,
      refreshToken: adapter.refreshToken,
    }),
  });
  const body = await res.json().catch(() => ({})) as Partial<ShopifyRefreshResponse> & {
    error?: string;
  };
  if (!res.ok || !body.accessToken || !body.refreshToken) {
    throw new Error(body.error ?? `Shopify token refresh failed with HTTP ${res.status}.`);
  }

  return {
    ...adapter,
    accessToken: String(body.accessToken),
    refreshToken: String(body.refreshToken),
    accessTokenExpiresAt: body.accessTokenExpiresAt
      ? String(body.accessTokenExpiresAt)
      : undefined,
    refreshTokenExpiresAt: body.refreshTokenExpiresAt
      ? String(body.refreshTokenExpiresAt)
      : undefined,
  };
}

export function shopifyTokenNeedsRefresh(adapter: ShopifyAdapterConfig): boolean {
  if (!adapter.refreshToken || !adapter.accessTokenExpiresAt) return false;
  const expiresAt = Date.parse(adapter.accessTokenExpiresAt);
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt <= Date.now() + 5 * 60 * 1000;
}
