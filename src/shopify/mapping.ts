/**
 * Shopify Article ↔ RemotePost mapping.
 *
 * Body conversion:
 *   pull: Article.body (HTML)  → markdown  via existing turndown utility
 *   push: RemotePost.body (md) → HTML       via markdown-it
 *
 * The HTML round-trip was empirically validated against a dev store (see
 * scripts/shopify-spike-report.md): Shopify's API path is essentially
 * raw passthrough, so the only fidelity loss is markdown's own lossiness
 * (which is acceptable — markdown is the user's source of truth).
 *
 * Status mapping:
 *   Shopify is binary (isPublished + publishedAt). 'scheduled' (Ghost-ism)
 *   is represented as isPublished=true with a future publishDate; on read
 *   that comes back as 'published' since Shopify doesn't surface scheduling
 *   as a separate state. Round-tripping a 'scheduled' Ghost post through
 *   Shopify will degrade to 'published' — documented limitation.
 */

import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';
import { htmlToMarkdown } from '../utils/markdown.js';
import {
  CreatePostInput,
  RemoteContainer,
  RemoteContentItem,
  RemotePost,
  UpdatePostInput,
} from '../cms/types.js';
import {
  ShopifyArticle,
  ShopifyArticleInput,
  ShopifyBlog,
  ShopifyPage,
  ShopifyPageInput,
  ShopifyProduct,
  ShopifyProductInput,
} from './api.js';

const md = new MarkdownIt({
  html: true, // pass through raw HTML — Shopify accepts it (spike-confirmed)
  linkify: false,
  breaks: false,
  typographer: false,
});

// Shopify's API path is essentially passthrough (spike-confirmed: <script>,
// <iframe>, <style>, event handlers all survive). The vault content is the
// *last* sanitization point before merchant storefront rendering. Treat the
// vault as user input that could be poisoned (AI-generated content, shared
// vaults, compromised collaborators).
const SAFE_HTML_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr',
    'ul', 'ol', 'li',
    'strong', 'em', 'b', 'i', 'u', 's', 'sub', 'sup',
    'blockquote', 'cite', 'q',
    'a', 'abbr', 'time',
    'code', 'pre', 'kbd', 'samp', 'var',
    'figure', 'figcaption', 'picture', 'img', 'source',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
    'details', 'summary',
    'div', 'span',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading', 'srcset', 'sizes'],
    source: ['src', 'srcset', 'media', 'type'],
    code: ['class'], // language-* for syntax highlighting
    th: ['scope', 'colspan', 'rowspan'],
    td: ['colspan', 'rowspan'],
    time: ['datetime'],
    abbr: ['title'],
    blockquote: ['cite'],
    q: ['cite'],
    '*': ['id', 'class'],
  },
  // Allow https + relative URLs only — strips javascript:, data:, vbscript:
  allowedSchemes: ['https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['https', 'data'] }, // data: only for img (small inline only)
  // Drop <script>, <style>, <object>, <embed>, <iframe>, <form>, etc. entirely.
  disallowedTagsMode: 'discard',
};

export interface MarkdownToHtmlOptions {
  /** When true, skip sanitization and pass raw HTML through. Use only for
   *  vaults you fully control. Default false. */
  trustVaultContent?: boolean;
}

export function markdownToHtml(
  markdown: string,
  options: MarkdownToHtmlOptions = {},
): string {
  const raw = md.render(markdown).trim();
  if (options.trustVaultContent) return raw;
  return sanitizeHtml(raw, SAFE_HTML_OPTIONS);
}

export function shopifyArticleToRemotePost(article: ShopifyArticle, shop?: string): RemotePost {
  const status = article.isPublished ? 'published' : 'draft';
  const container: RemoteContainer = {
    id: article.blog.id,
    handle: article.blog.handle,
    title: article.blog.title ?? article.blog.handle,
  };
  const url = shop && article.isPublished
    ? `https://${shop.replace(/^https?:\/\//, '').replace(/\.myshopify\.com$/, '.myshopify.com')}/blogs/${article.blog.handle}/${article.handle}`
    : null;

  return {
    kind: 'article',
    id: article.id,
    slug: article.handle,
    title: article.title,
    body: htmlToMarkdown(article.body),
    status,
    tags: article.tags ?? [],
    summary: article.summary && article.summary.length > 0 ? article.summary : null,
    featureImage: article.image?.url ?? null,
    author: article.author?.name ?? null,
    updatedAt: article.updatedAt ?? article.createdAt,
    createdAt: article.createdAt,
    publishedAt: article.publishedAt,
    container,
    url,
  };
}

export function shopifyPageToRemotePost(page: ShopifyPage, shop?: string): RemoteContentItem {
  const status = page.isPublished ? 'published' : 'draft';
  const url = shop && page.isPublished
    ? `https://${shop.replace(/^https?:\/\//, '').replace(/\.myshopify\.com$/, '.myshopify.com')}/pages/${page.handle}`
    : null;

  return {
    kind: 'page',
    id: page.id,
    slug: page.handle,
    title: page.title,
    body: htmlToMarkdown(page.body),
    status,
    tags: [],
    summary: page.bodySummary && page.bodySummary.length > 0 ? page.bodySummary : null,
    featureImage: null,
    author: null,
    updatedAt: page.updatedAt ?? page.createdAt,
    createdAt: page.createdAt,
    publishedAt: page.publishedAt,
    container: null,
    url,
  };
}

export function shopifyProductToRemotePost(product: ShopifyProduct): RemoteContentItem {
  const status = product.status === 'ACTIVE' ? 'published' : 'draft';
  const image = product.featuredMedia?.preview?.image ?? null;

  return {
    kind: 'product',
    id: product.id,
    slug: product.handle,
    title: product.title,
    body: htmlToMarkdown(product.descriptionHtml),
    status,
    tags: product.tags ?? [],
    summary: null,
    featureImage: image?.url ?? null,
    author: null,
    updatedAt: product.updatedAt ?? product.createdAt,
    createdAt: product.createdAt,
    publishedAt: product.status === 'ACTIVE' ? product.createdAt : null,
    container: null,
    url: product.status === 'ACTIVE' ? product.onlineStoreUrl : null,
  };
}

export function shopifyBlogToContainer(blog: ShopifyBlog): RemoteContainer {
  return { id: blog.id, handle: blog.handle, title: blog.title };
}

/** CreatePostInput → Shopify ArticleCreateInput. `blogId` resolved by caller. */
export function createInputToShopify(
  input: CreatePostInput,
  blogId: string,
  options: MarkdownToHtmlOptions = {},
): ShopifyArticleInput {
  const isPublished = input.status === 'published' || input.status === 'scheduled';
  return {
    blogId,
    title: input.title,
    handle: input.slug,
    body: markdownToHtml(input.body, options),
    summary: input.summary ?? undefined,
    author: input.author ? { name: input.author } : undefined,
    tags: input.tags,
    image: input.featureImage ? { url: input.featureImage } : undefined,
    isPublished,
  };
}

export function updateInputToShopify(
  input: UpdatePostInput,
  blogId?: string,
  options: MarkdownToHtmlOptions = {},
): ShopifyArticleInput {
  const out: ShopifyArticleInput = {};
  if (input.title !== undefined) out.title = input.title;
  if (input.slug !== undefined) out.handle = input.slug;
  if (input.body !== undefined) out.body = markdownToHtml(input.body, options);
  if (input.summary !== undefined) out.summary = input.summary ?? undefined;
  if (input.author !== undefined && input.author !== null) out.author = { name: input.author };
  if (input.tags !== undefined) out.tags = input.tags;
  if (input.featureImage !== undefined) {
    out.image = input.featureImage ? { url: input.featureImage } : null;
  }
  if (input.status !== undefined) {
    out.isPublished = input.status === 'published' || input.status === 'scheduled';
  }
  if (blogId !== undefined) out.blogId = blogId;
  return out;
}

export function createPageInputToShopify(
  input: CreatePostInput,
  options: MarkdownToHtmlOptions = {},
): ShopifyPageInput {
  return {
    title: input.title,
    handle: input.slug,
    body: markdownToHtml(input.body, options),
    isPublished: input.status === 'published' || input.status === 'scheduled',
  };
}

export function updatePageInputToShopify(
  input: UpdatePostInput,
  options: MarkdownToHtmlOptions = {},
): ShopifyPageInput {
  const out: ShopifyPageInput = {};
  if (input.title !== undefined) out.title = input.title;
  if (input.slug !== undefined) out.handle = input.slug;
  if (input.body !== undefined) out.body = markdownToHtml(input.body, options);
  if (input.status !== undefined) {
    out.isPublished = input.status === 'published' || input.status === 'scheduled';
  }
  return out;
}

export function createProductInputToShopify(
  input: CreatePostInput,
  options: MarkdownToHtmlOptions = {},
): ShopifyProductInput {
  return {
    title: input.title,
    handle: input.slug,
    descriptionHtml: markdownToHtml(input.body, options),
    status: input.status === 'published' || input.status === 'scheduled' ? 'ACTIVE' : 'DRAFT',
    tags: input.tags,
  };
}

export function updateProductInputToShopify(
  input: UpdatePostInput,
  options: MarkdownToHtmlOptions = {},
): ShopifyProductInput {
  const out: ShopifyProductInput = {};
  if (input.title !== undefined) out.title = input.title;
  if (input.slug !== undefined) out.handle = input.slug;
  if (input.body !== undefined) out.descriptionHtml = markdownToHtml(input.body, options);
  if (input.tags !== undefined) out.tags = input.tags;
  if (input.status !== undefined) {
    out.status = input.status === 'published' || input.status === 'scheduled' ? 'ACTIVE' : 'DRAFT';
  }
  return out;
}
