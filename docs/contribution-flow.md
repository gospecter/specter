# Contribution Flow

The private repo remains the canonical product/release repo. The public repo is a sanitized source mirror.

## How Changes Flow

1. Development happens in the private repo.
2. A release is built, signed, notarized, and published from the private pipeline.
3. A sanitized source snapshot is exported to the public repo.
4. The public repo is tagged with the same version as the official binary.

## Public Pull Requests

Public PRs are welcome for:

- Bug fixes.
- Tests.
- Documentation.
- CMS adapter improvements.
- Small sync-engine improvements with clear tests.

Accepted public PRs are reviewed in the public repo, then manually applied or cherry-picked into the private canonical repo. The next public export mirrors the accepted change back out.

## Larger Changes

Open an issue before starting work that touches:

- `CmsAdapter` contracts.
- Frontmatter schema.
- Conflict handling.
- Official binary packaging/update behavior.
- Desktop release/update behavior.

Those areas affect every platform and need design discussion before implementation.

## New CMS Adapters

A good adapter PR includes:

- A short platform/auth overview.
- A `CmsAdapter` implementation.
- Contract tests using `runCmsAdapterContract(...)`.
- Mapping tests for body/frontmatter conversion.
- Notes about body-format lossiness, optimistic locking, pagination, and rate limits.
