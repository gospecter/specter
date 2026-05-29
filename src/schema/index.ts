/**
 * Single source of truth for **on-disk** schemas.
 *
 * Every type exported here is consumed by `scripts/gen-schemas.mjs` which:
 *   1. Generates JSON Schema → `schemas/*.json`
 *   2. Generates Swift structs → `mac/Sources/Specter/Generated/*.swift`
 *
 * If a shape isn't on disk (e.g. `RemotePost`, `CmsAdapter`), it does NOT
 * belong here — runtime types stay in their feature modules.
 *
 * **Rules for changes:**
 *   - Add or rename a field? Update the type below + run `npm run schema:gen`.
 *   - CI runs `npm run schema:check` and fails on drift between the
 *     committed `schemas/` and what regen produces.
 *   - Back-compat: `PostFrontmatterV1` must stay valid until the deprecation
 *     window closes (~v0.6.0). Until then, the writer emits V1 and the
 *     reader accepts both V1 and V2 (see `src/utils/frontmatter.ts`).
 */

// ---- DaemonConfig (config.json) ----
export type { DaemonConfig, DaemonState, TargetConfig } from '../config.js';

// ---- AdapterConfig (per-target credentials) ----
export type { AdapterConfig, Platform, PostStatus } from '../cms/types.js';

// ---- Frontmatter (per-vault-file YAML block) ----
//
// V1 is what every shipped user has today. V2 is what v0.4.0+ will write.
// During the deprecation window both must parse; the schema describes both.

import type { PostFrontmatter } from '../types.js';

/** Legacy v1 frontmatter — flat `ghost_*` keys. Currently the only shape on disk. */
export type PostFrontmatterV1 = PostFrontmatter;

/**
 * V2 frontmatter — namespaced `cms` block. Written by v0.4.0+; readable
 * by v0.3.2+. Top-level user fields (`tags`, `feature_image`, `excerpt`,
 * `local_updated_at`) keep their current location.
 */
export interface PostFrontmatterV2 {
  cms: {
    platform: 'ghost' | 'shopify';
    /** Native ID from the CMS — opaque to the daemon. */
    id: string;
    slug: string;
    status: 'draft' | 'published' | 'scheduled';
    updated_at: string;
  };
  local_updated_at: string | null;
  tags: string[];
  feature_image: string | null;
  excerpt: string | null;
}

/**
 * Union of both shapes — what the parser must accept during the deprecation
 * window. Either `cms` block OR `ghost_*` keys must be present for a
 * file to be considered tracked; bare files have neither and are pending push.
 */
export type PostFrontmatterAny = PostFrontmatterV1 | PostFrontmatterV2;
