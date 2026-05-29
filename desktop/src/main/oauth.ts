import { Notification, app } from 'electron';
import { upsertShopifyTarget } from './config.js';

const SHOPIFY_EXCHANGE_URL = 'https://spectersync.com/api/oauth/shopify/exchange';

interface ShopifyExchangeResponse {
  provider: string;
  shop: string;
  accessToken: string;
  refreshToken?: string;
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
  scope?: string;
}

export function registerOAuthProtocol(): void {
  app.setAsDefaultProtocolClient('specter');
  if (!app.isDefaultProtocolClient('specter')) {
    show(
      'Specter OAuth needs attention',
      'Another app appears to own specter:// links. Reinstall or relaunch Specter before connecting Shopify.',
    );
  }
}

export async function handleOAuthUrl(raw: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  if (url.protocol !== 'specter:' || url.hostname !== 'oauth' || url.pathname !== '/complete') {
    return false;
  }

  const provider = url.searchParams.get('provider');
  const shop = url.searchParams.get('shop');
  const code = url.searchParams.get('code');
  if (provider !== 'shopify' || !shop || !code) {
    show('Shopify connection failed', 'The OAuth callback was missing required details.');
    return true;
  }

  try {
    const token = await exchangeShopifyCode(code);
    upsertShopifyTarget(token.shop, {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      accessTokenExpiresAt: token.accessTokenExpiresAt,
      refreshTokenExpiresAt: token.refreshTokenExpiresAt,
    });
    show('Shopify connected', `Specter can now sync Shopify articles for ${token.shop}.`);
  } catch (err) {
    show('Shopify connection failed', (err as Error).message);
  }
  return true;
}

export function findOAuthUrl(argv: string[]): string | null {
  return argv.find((arg) => arg.startsWith('specter://oauth/complete')) ?? null;
}

async function exchangeShopifyCode(code: string): Promise<ShopifyExchangeResponse> {
  const res = await fetch(SHOPIFY_EXCHANGE_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ code }),
  });
  const body = await res.json().catch(() => ({})) as Partial<ShopifyExchangeResponse> & {
    error?: string;
  };
  if (!res.ok || !body.shop || !body.accessToken) {
    throw new Error(body.error ?? `Token exchange failed with HTTP ${res.status}.`);
  }
  return {
    provider: String(body.provider ?? 'shopify'),
    shop: String(body.shop),
    accessToken: String(body.accessToken),
    refreshToken: body.refreshToken ? String(body.refreshToken) : undefined,
    accessTokenExpiresAt: body.accessTokenExpiresAt
      ? String(body.accessTokenExpiresAt)
      : undefined,
    refreshTokenExpiresAt: body.refreshTokenExpiresAt
      ? String(body.refreshTokenExpiresAt)
      : undefined,
    scope: body.scope ? String(body.scope) : undefined,
  };
}

function show(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  new Notification({ title, body }).show();
}
