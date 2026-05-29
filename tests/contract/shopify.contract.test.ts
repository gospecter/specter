/**
 * Shopify wired up to the shared CmsAdapter contract.
 *
 * Capabilities: Shopify has no native optimistic lock (last-writer-wins; the
 * engine handles read-then-write conflict detection) and a multi-container
 * model (articles belong to blogs).
 */

import { ShopifyAdapter } from '../../src/shopify/adapter.js';
import { FakeShopifyApi } from '../fakes/FakeShopifyApi.js';
import { runCmsAdapterContract } from './cmsAdapter.contract.js';

runCmsAdapterContract(
  'Shopify',
  async () => {
    const api = new FakeShopifyApi();
    api.seedDefaultBlog();
    return new ShopifyAdapter(api, 'fake.myshopify.com');
  },
  { optimisticLock: false, containers: 'multi' },
);
