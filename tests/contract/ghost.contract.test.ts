/**
 * Ghost wired up to the shared CmsAdapter contract.
 *
 * Capabilities: Ghost has server-side optimistic locking (UPDATE_COLLISION on
 * stale updated_at) and a flat post namespace (no containers).
 */

import { FakeGhostApi } from '../fakes/FakeGhostApi.js';
import { runCmsAdapterContract } from './cmsAdapter.contract.js';

runCmsAdapterContract(
  'Ghost',
  async () => new FakeGhostApi().adapter(),
  { optimisticLock: true, containers: 'flat' },
);
