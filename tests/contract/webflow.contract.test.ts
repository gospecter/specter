/**
 * Webflow wired up to the shared CmsAdapter contract.
 *
 * Capabilities: Webflow has no native optimistic lock (last-writer-wins; the
 * engine handles read-then-write conflict detection) and a multi-container
 * model (items belong to a CMS collection).
 */

import { WebflowAdapter } from '../../src/webflow/adapter.js';
import { FakeWebflowApi } from '../fakes/FakeWebflowApi.js';
import { runCmsAdapterContract } from './cmsAdapter.contract.js';

runCmsAdapterContract(
  'Webflow',
  async () => {
    const api = new FakeWebflowApi();
    api.seedDefaultCollection();
    return new WebflowAdapter(api, 'site_fake');
  },
  { optimisticLock: false, containers: 'multi' },
);
