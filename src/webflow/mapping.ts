/**
 * Webflow collection-item ↔ RemotePost mapping.
 *
 * Body conversion:
 *   pull: rich-text field (HTML) → markdown  via turndown (htmlToMarkdown)
 *   push: RemotePost.body (md)   → HTML       via markdown-it
 *
 * Sync identity: a Webflow item's id is unique but the Data API addresses
 * items by (collectionId, itemId). We therefore use a **composite id**
 * `collectionId:itemId` as the engine-visible `RemotePost.id` (stored in
 * frontmatter). It is still immutable — items never move between collections —
 * and round-trips back to the API coordinates via `parseCompositeId`.
 *
 * Field mapping: collections have user-defined fields, so there is no fixed
 * title/body/slug. We auto-detect (`name` → title, `slug` → slug, first
 * RichText field → body, `tags` → tags) and let config override per collection.
 */

import MarkdownIt from 'markdown-it';
import { htmlToMarkdown } from '../utils/markdown.js';
import {
  ContentKind,
  CreatePostInput,
  PostStatus,
  RemoteContainer,
  RemoteContentItem,
  UpdatePostInput,
} from '../cms/types.js';
import { WebflowCollection, WebflowField, WebflowItem, WebflowItemInput } from './api.js';

/** The content-kind string for a collection: `webflow:<collectionSlug>`. */
export function collectionKind(collection: WebflowCollection): ContentKind {
  return `webflow:${collection.slug}` as ContentKind;
}

/** Inverse of {@link collectionKind}: strip the `webflow:` prefix to the slug.
 *  Tolerates a bare slug so callers can pass either form. */
export function kindToSlug(kind: ContentKind): string {
  const s = String(kind);
  return s.startsWith('webflow:') ? s.slice('webflow:'.length) : s;
}

const md = new MarkdownIt({ html: true, linkify: true });

/** Separator joining collectionId + itemId into the composite RemotePost id. */
export const WEBFLOW_ID_SEP = ':';

export function compositeId(collectionId: string, itemId: string): string {
  return `${collectionId}${WEBFLOW_ID_SEP}${itemId}`;
}

export function parseCompositeId(id: string): { collectionId: string; itemId: string } {
  const idx = id.indexOf(WEBFLOW_ID_SEP);
  if (idx === -1) {
    // Bare item id (legacy/hand-written). Caller must resolve the collection.
    return { collectionId: '', itemId: id };
  }
  return { collectionId: id.slice(0, idx), itemId: id.slice(idx + 1) };
}

/** URL-safe slug from a title, used when the caller doesn't supply one. */
export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'untitled'
  );
}

export function markdownToHtml(markdown: string): string {
  return md.render(markdown).trim();
}

/** Optional per-collection overrides (mirrors AdapterConfig.fieldMap entry). */
export interface FieldMapOverride {
  title?: string;
  slug?: string;
  body?: string;
  tags?: string;
}

/** Resolved field slugs the adapter reads/writes for a collection. */
export interface FieldMapping {
  titleField: string;
  slugField: string;
  /** Field slug holding the body HTML, or null if the collection has none. */
  bodyField: string | null;
  tagsField: string;
}

function firstRichTextField(fields: WebflowField[]): WebflowField | undefined {
  return fields.find((f) => f.type === 'RichText');
}

/**
 * Decide which collection fields back title/slug/body/tags. Webflow guarantees
 * `name` and `slug` on every collection; body defaults to the first RichText
 * field. Any of these can be overridden in config (`fieldMap[collectionId]`).
 */
export function resolveFieldMapping(
  collection: WebflowCollection,
  override?: FieldMapOverride,
): FieldMapping {
  return {
    titleField: override?.title ?? 'name',
    slugField: override?.slug ?? 'slug',
    bodyField: override?.body ?? firstRichTextField(collection.fields)?.slug ?? null,
    tagsField: override?.tags ?? 'tags',
  };
}

export function collectionToContainer(collection: WebflowCollection): RemoteContainer {
  return { id: collection.id, handle: collection.slug, title: collection.displayName };
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function asTags(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((t) => asString(t)).filter(Boolean);
  return [];
}

export function itemToRemotePost(
  collection: WebflowCollection,
  mapping: FieldMapping,
  item: WebflowItem,
): RemoteContentItem {
  const fd = item.fieldData;
  const bodyHtml = mapping.bodyField ? asString(fd[mapping.bodyField]) : '';
  const status: PostStatus = item.isDraft ? 'draft' : 'published';
  return {
    kind: collectionKind(collection),
    id: compositeId(collection.id, item.id),
    slug: asString(fd[mapping.slugField]),
    title: asString(fd[mapping.titleField]),
    body: htmlToMarkdown(bodyHtml),
    status,
    tags: asTags(fd[mapping.tagsField]),
    summary: null,
    featureImage: null,
    author: null,
    updatedAt: item.lastUpdated,
    createdAt: item.createdOn,
    publishedAt: item.lastPublished,
    container: collectionToContainer(collection),
    url: null,
  };
}

/** Build the create payload for a new item in `collection`. */
export function createInputToWebflow(
  mapping: FieldMapping,
  input: CreatePostInput,
): WebflowItemInput {
  const fieldData: Record<string, unknown> = {
    [mapping.titleField]: input.title,
    [mapping.slugField]: input.slug || slugify(input.title),
  };
  if (mapping.bodyField) fieldData[mapping.bodyField] = markdownToHtml(input.body);
  if (input.tags) fieldData[mapping.tagsField] = input.tags;
  return {
    isDraft: (input.status ?? 'draft') !== 'published',
    fieldData,
  };
}

/** Build a partial update payload — only fields present in `input` are written
 *  so unspecified fields (e.g. tags on a title-only edit) are left intact. */
export function updateInputToWebflow(
  mapping: FieldMapping,
  input: UpdatePostInput,
): WebflowItemInput {
  const fieldData: Record<string, unknown> = {};
  if (input.title !== undefined) fieldData[mapping.titleField] = input.title;
  if (input.slug !== undefined) fieldData[mapping.slugField] = input.slug;
  if (input.body !== undefined && mapping.bodyField) {
    fieldData[mapping.bodyField] = markdownToHtml(input.body);
  }
  if (input.tags !== undefined) fieldData[mapping.tagsField] = input.tags;
  const out: WebflowItemInput = { fieldData };
  if (input.status !== undefined) out.isDraft = input.status !== 'published';
  return out;
}
