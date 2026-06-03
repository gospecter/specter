import { Notification, app } from 'electron';
import { readConfig, upsertShopifyTarget } from './config.js';
import { openWindow, setPendingConnect } from './windows.js';

/** OAuth broker shipped with PRO. DIY self-hosters override it via the
 *  `oauthBaseUrl` config field (see AppConfig). */
const DEFAULT_OAUTH_BASE_URL = 'https://spectersync.com';

/** Origin of the OAuth broker to talk to: the configured `oauthBaseUrl` when
 *  set, otherwise the hosted default. Read fresh each call so a Settings change
 *  takes effect without restarting. */
export function oauthBaseUrl(): string {
  const configured = readConfig()?.oauthBaseUrl?.trim();
  if (!configured) return DEFAULT_OAUTH_BASE_URL;
  // Tolerate a trailing slash so "<origin>/" + "/api/…" doesn't double up.
  return configured.endsWith('/') ? configured.slice(0, -1) : configured;
}

/** Build a URL on the configured broker, e.g. `/api/oauth/webflow/start`. */
export function oauthEndpoint(path: string): string {
  return oauthBaseUrl() + path;
}

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
  const code = url.searchParams.get('code');
  if (!code) {
    show('Connection failed', 'The OAuth callback was missing required details.');
    return true;
  }

  if (provider === 'shopify') {
    const shop = url.searchParams.get('shop');
    if (!shop) {
      show('Shopify connection failed', 'The OAuth callback was missing the shop.');
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

  if (provider === 'webflow') {
    // Webflow's token grants access to the user's authorized sites but the
    // callback carries no siteId — so we exchange for the (long-lived) token
    // and hand it to the connect form, where the user picks the site + the CMS
    // collections to sync. The token rides in the form's single token field.
    try {
      const token = await exchangeWebflowCode(code);
      setPendingConnect({ platform: 'webflow', apiToken: token.accessToken });
      openWindow('webflow-connect');
      show('Webflow authorized', 'Choose your site and collections to finish connecting.');
    } catch (err) {
      show('Webflow connection failed', (err as Error).message);
    }
    return true;
  }

  show('Connection failed', `Unknown OAuth provider: ${provider ?? 'none'}.`);
  return true;
}

export function findOAuthUrl(argv: string[]): string | null {
  return argv.find((arg) => arg.startsWith('specter://oauth/complete')) ?? null;
}

async function exchangeShopifyCode(code: string): Promise<ShopifyExchangeResponse> {
  const res = await fetch(oauthEndpoint('/api/oauth/shopify/exchange'), {
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

interface WebflowExchangeResponse {
  provider: string;
  accessToken: string;
  scope?: string;
}

async function exchangeWebflowCode(code: string): Promise<WebflowExchangeResponse> {
  const res = await fetch(oauthEndpoint('/api/oauth/webflow/exchange'), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ code }),
  });
  const body = await res.json().catch(() => ({})) as Partial<WebflowExchangeResponse> & {
    error?: string;
  };
  if (!res.ok || !body.accessToken) {
    throw new Error(body.error ?? `Token exchange failed with HTTP ${res.status}.`);
  }
  return {
    provider: String(body.provider ?? 'webflow'),
    accessToken: String(body.accessToken),
    scope: body.scope ? String(body.scope) : undefined,
  };
}

function show(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  new Notification({ title, body }).show();
}
