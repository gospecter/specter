import { describe, expect, it } from 'vitest';
import {
  mergeTargetsForConfig,
  type AppConfig,
  type TargetConfig,
} from '../../desktop/src/main/config-merge';

const base: AppConfig = {
  ghostUrl: 'http://localhost:2368',
  adminApiKey: 'id:secret',
  vaultPath: '/tmp/specter',
  syncFolderPath: '',
  pullDrafts: true,
  pullPublished: true,
  conflictStrategy: 'ask',
  syncMode: 'manual',
  watchDebounceMs: 2000,
};

const shopify: TargetConfig = {
  handle: 'shopify-specter',
  label: 'Shopify',
  syncFolderPath: 'shopify',
  pullDrafts: true,
  pullPublished: true,
  conflictStrategy: 'ask',
  syncMode: 'manual',
  adapter: {
    platform: 'shopify',
    shop: 'example-store.myshopify.com',
    accessToken: 'shpat_test',
  },
};

describe('desktop config target merge', () => {
  it('prepends synthesized Ghost target when saving a config with only Shopify target', () => {
    const targets = mergeTargetsForConfig([shopify], base);

    expect(targets).toHaveLength(2);
    expect(targets[0].adapter.platform).toBe('ghost');
    expect(targets[1]).toEqual(shopify);
  });

  it('updates an existing Ghost target without dropping Shopify targets', () => {
    const oldGhost: TargetConfig = {
      ...shopify,
      handle: 'ghost',
      label: 'Ghost',
      syncFolderPath: 'old',
      adapter: {
        platform: 'ghost',
        ghostUrl: 'https://old.example',
        adminApiKey: 'old:secret',
      },
    };

    const targets = mergeTargetsForConfig([oldGhost, shopify], base);

    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({
      handle: 'ghost',
      syncFolderPath: '',
      adapter: {
        platform: 'ghost',
        ghostUrl: 'http://localhost:2368',
        adminApiKey: 'id:secret',
      },
    });
    expect(targets[1]).toEqual(shopify);
  });
});
