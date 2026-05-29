import matter from 'gray-matter';
import { ContentKind, Platform } from '../cms/types.js';
import { PostFrontmatter, DEFAULT_FRONTMATTER } from '../types.js';

export interface ParsedPost {
  frontmatter: PostFrontmatter;
  title: string;
  content: string;
  rawContent: string;
}

/**
 * Dual-read parser (v0.3.2). Accepts both frontmatter shapes:
 *
 *   New (v2 — written by v0.4.0+):
 *     cms:
 *       platform: ghost
 *       id: abc123
 *       slug: my-post
 *       status: published
 *       updated_at: 2026-…
 *
 *   Legacy (v1 — currently written, all shipped vaults today):
 *     ghost_id: abc123
 *     ghost_slug: my-post
 *     ghost_status: published
 *     ghost_updated_at: 2026-…
 *
 * Reads prefer v2 when present; fall back to v1. Both shapes coexist in a
 * vault during the deprecation window without conflict. Writes still produce
 * v1 only — dual-write lands with the engine refactor in v0.4.0.
 */
export function parsePostContent(rawContent: string): ParsedPost {
  const { data, content } = matter(rawContent);
  const cms = isCmsBlock(data.cms) ? data.cms : null;

  // gray-matter's YAML parser auto-converts ISO 8601 strings to Date objects.
  // Coerce back to string so the typed shape holds at runtime.
  const frontmatter: PostFrontmatter = {
    cms_kind: asContentKind(cms?.kind) ?? DEFAULT_FRONTMATTER.cms_kind,
    ghost_id: asString(cms?.id ?? data.ghost_id) ?? DEFAULT_FRONTMATTER.ghost_id,
    ghost_slug: asString(cms?.slug ?? data.ghost_slug) ?? DEFAULT_FRONTMATTER.ghost_slug,
    ghost_status:
      (asString(cms?.status ?? data.ghost_status) as PostFrontmatter['ghost_status']) ??
      DEFAULT_FRONTMATTER.ghost_status,
    ghost_updated_at:
      asIsoString(cms?.updated_at ?? data.ghost_updated_at) ??
      DEFAULT_FRONTMATTER.ghost_updated_at,
    local_updated_at: asIsoString(data.local_updated_at) ?? DEFAULT_FRONTMATTER.local_updated_at,
    tags: Array.isArray(data.tags) ? data.tags : DEFAULT_FRONTMATTER.tags,
    feature_image: asString(data.feature_image) ?? DEFAULT_FRONTMATTER.feature_image,
    excerpt: asString(data.excerpt) ?? DEFAULT_FRONTMATTER.excerpt,
  };

  const titleMatch = content.match(/^#\s+(.+?)(?:\n|$)/m);
  const title = titleMatch ? titleMatch[1].trim() : '';
  const bodyContent = titleMatch
    ? content.slice(titleMatch.index! + titleMatch[0].length).trim()
    : content.trim();

  return { frontmatter, title, content: bodyContent, rawContent };
}

interface CmsBlock {
  platform?: string;
  kind?: string;
  id?: string;
  slug?: string;
  status?: string;
  updated_at?: string;
}

function isCmsBlock(value: unknown): value is CmsBlock {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function asString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/** Same as asString, but specifically for ISO timestamps — preserves the
 *  string form when YAML gave us a Date. */
function asIsoString(value: unknown): string | null {
  return asString(value);
}

export interface SerializeOptions {
  /** Discriminator for the v2 `cms` block. Defaults to 'ghost' so callers that
   *  predate the multi-CMS work (mostly test fixtures) keep working unchanged. */
  platform?: Platform;
  /** Resource kind for the v2 `cms` block. Defaults to legacy `post`. */
  kind?: ContentKind;
}

/**
 * Write a post to its on-disk form. As of v0.4.0 this emits **both** the
 * legacy v1 `ghost_*` keys (so v0.3.x can still read the file) AND a v2
 * `cms:` block (so v0.5+ can drop the legacy keys without a flag day). Drop
 * v1 emission in v0.6.0 once the dual-write release window has elapsed.
 *
 * The `cms` block is only emitted when the post has actually been synced —
 * a frontmatter with no `ghost_id` represents a never-pushed local file,
 * and a stub cms block with empty id/slug would just be noise.
 */
export function serializePostContent(
  frontmatter: PostFrontmatter,
  title: string,
  content: string,
  options: SerializeOptions = {},
): string {
  const platform: Platform = options.platform ?? 'ghost';
  const kind: ContentKind = options.kind ?? frontmatter.cms_kind ?? 'post';
  const fmData: Record<string, unknown> = {};

  // v2 `cms:` block — listed first so a quick visual scan shows the canonical
  // identifier block before the v1 mirror. For default posts, only emit it once
  // there is a remote identity. Non-post kinds need the block even before the
  // first push so a local draft can declare "create this as a page".
  if (frontmatter.ghost_id || kind !== 'post') {
    const cms: Record<string, unknown> = {
      platform,
    };
    if (kind !== 'post') cms.kind = kind;
    if (frontmatter.ghost_id) cms.id = frontmatter.ghost_id;
    cms.status = frontmatter.ghost_status;
    if (frontmatter.ghost_slug) cms.slug = frontmatter.ghost_slug;
    if (frontmatter.ghost_updated_at) cms.updated_at = frontmatter.ghost_updated_at;
    fmData.cms = cms;
  }

  // v1 legacy mirror — kept for one release window so a downgrade to v0.3.x
  // doesn't lose ghost identity on re-read.
  if (frontmatter.ghost_id) fmData.ghost_id = frontmatter.ghost_id;
  if (frontmatter.ghost_slug) fmData.ghost_slug = frontmatter.ghost_slug;
  if (frontmatter.ghost_status) fmData.ghost_status = frontmatter.ghost_status;
  if (frontmatter.ghost_updated_at) fmData.ghost_updated_at = frontmatter.ghost_updated_at;

  if (frontmatter.local_updated_at) fmData.local_updated_at = frontmatter.local_updated_at;
  if (frontmatter.tags && frontmatter.tags.length > 0) fmData.tags = frontmatter.tags;
  if (frontmatter.feature_image) fmData.feature_image = frontmatter.feature_image;
  if (frontmatter.excerpt) fmData.excerpt = frontmatter.excerpt;

  const yamlContent = matter.stringify('', fmData);

  const parts: string[] = [yamlContent.trim()];
  if (title) {
    parts.push('');
    parts.push(`# ${title}`);
  }
  if (content) {
    parts.push('');
    parts.push(content);
  }
  return parts.join('\n') + '\n';
}

function asContentKind(value: unknown): ContentKind | null {
  const raw = asString(value);
  if (!raw) return null;
  if (
    raw === 'post' ||
    raw === 'page' ||
    raw === 'article' ||
    raw === 'product' ||
    raw.startsWith('wordpress:')
  ) {
    return raw as ContentKind;
  }
  return null;
}

export function titleToFilename(title: string): string {
  return (
    title
      .replace(/[^a-zA-Z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase()
      .slice(0, 100) || 'untitled'
  );
}

export function hasLocalChanges(fileModifiedTime: number, frontmatter: PostFrontmatter): boolean {
  if (!frontmatter.local_updated_at) return true;
  const lastSyncTime = new Date(frontmatter.local_updated_at).getTime();
  return fileModifiedTime > lastSyncTime + 1000;
}

export function isGhostNewer(
  ghostUpdatedAt: string,
  localGhostUpdatedAt: string | null,
): boolean {
  if (!localGhostUpdatedAt) return true;
  return new Date(ghostUpdatedAt).getTime() > new Date(localGhostUpdatedAt).getTime();
}
