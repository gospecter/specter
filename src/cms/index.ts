/**
 * CmsAdapter factory.
 *
 * Picks the right adapter based on `config.platform`. Backward-compat:
 * if `platform` is missing (old configs from before Phase 1 expansion),
 * defaults to "ghost" and treats `ghostUrl`/`adminApiKey` as required.
 */

import { GhostApiClient } from '../ghost/api.js';
import { GhostAdapter } from '../ghost/adapter.js';
import { ShopifyApiClient } from '../shopify/api.js';
import { ShopifyAdapter } from '../shopify/adapter.js';
import { WordPressApiClient } from '../wordpress/api.js';
import { WordPressAdapter } from '../wordpress/adapter.js';
import { WebflowApiClient } from '../webflow/api.js';
import { WebflowAdapter } from '../webflow/adapter.js';
import { CmsAdapter } from './adapter.js';
import { AdapterConfig } from './types.js';

export function createAdapter(config: AdapterConfig): CmsAdapter {
  switch (config.platform) {
    case 'ghost': {
      const api = new GhostApiClient(config.ghostUrl, config.adminApiKey);
      return new GhostAdapter(api);
    }
    case 'shopify': {
      const api = new ShopifyApiClient(config.shop, config.accessToken, config.apiVersion);
      return new ShopifyAdapter(api, config.shop);
    }
    case 'wordpress': {
      const api = new WordPressApiClient(config.siteUrl, config.username, config.appPassword);
      return new WordPressAdapter(api, config.siteUrl);
    }
    case 'webflow': {
      // OAuth access token (PRO) takes precedence over the site API token (DIY);
      // both are plain, long-lived bearer tokens on the wire.
      const token = config.accessToken ?? config.apiToken;
      if (!token) {
        throw new Error(
          'Webflow target has neither an apiToken nor an accessToken configured.',
        );
      }
      const api = new WebflowApiClient(config.siteId, token);
      return new WebflowAdapter(api, config.siteId, config.fieldMap);
    }
    default: {
      const _exhaustive: never = config;
      throw new Error(`Unknown platform: ${(_exhaustive as { platform: string }).platform}`);
    }
  }
}

export { CmsAdapter } from './adapter.js';
export * from './types.js';
