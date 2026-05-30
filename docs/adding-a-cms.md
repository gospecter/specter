# Adding a CMS Adapter

Every CMS integration plugs into SpecterSync through the shared `CmsAdapter` interface in `src/cms/adapter.ts`. The sync engine should not call platform APIs directly.

## Before Coding

Open an issue with the target platform and the use case. Include:

- The REST or GraphQL endpoints needed for posts and pages.
- The platform-native body format, such as HTML, blocks, or mobiledoc.
- The authentication mechanism.
- Whether the platform supports optimistic concurrency or requires read-then-write conflict checks.
- Any pagination, rate limit, media upload, or container model details.

This keeps adapter shape decisions visible before a broad implementation starts.

## Implementation Checklist

1. Add the platform config shape to `src/cms/types.ts`.
2. Implement the adapter in `src/<platform>/adapter.ts`.
3. Keep native API mapping in the platform folder, not in the sync engine.
4. Convert platform-native body data to markdown before returning `RemotePost`.
5. Convert markdown back to the platform-native format when creating or updating remote content.
6. Export the adapter through `src/cms/index.ts`.
7. Add or update tests for mapping, auth errors, pagination, and conflict behavior.

Reference implementations:

- [`src/ghost/adapter.ts`](../src/ghost/adapter.ts)
- [`src/shopify/adapter.ts`](../src/shopify/adapter.ts)
- [`src/wordpress/adapter.ts`](../src/wordpress/adapter.ts)

## Contract Tests

New adapters must run the shared contract suite from `tests/contract/cmsAdapter.contract.ts`.

Add a small test file next to the existing contract tests:

```ts
import { YourAdapter } from '../../src/your-platform/adapter.js';
import { FakeYourPlatformApi } from '../fakes/FakeYourPlatformApi.js';
import { runCmsAdapterContract } from './cmsAdapter.contract.js';

runCmsAdapterContract(
  'YourPlatform',
  async () => new YourAdapter(new FakeYourPlatformApi()),
  { optimisticLock: false, containers: 'flat' },
);
```

Set `optimisticLock` and `containers` to match the platform:

- `optimisticLock: true` when stale update detection is enforced by the platform or adapter.
- `optimisticLock: false` when the engine must handle read-then-write conflict detection.
- `containers: 'flat'` for platforms with one post namespace.
- `containers: 'multi'` for platforms where content belongs to a blog, section, collection, or similar container.

The contract suite covers the common create, read, update, delete, list, draft, tag, container, and conflict expectations. Platform-specific tests should cover the native API mapping details that the shared suite cannot see.
