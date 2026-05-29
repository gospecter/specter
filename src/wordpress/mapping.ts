import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';
import { htmlToMarkdown, htmlToPlainText } from '../utils/markdown.js';
import type {
  ContentKind,
  CreatePostInput,
  RemoteContentItem,
  UpdatePostInput,
} from '../cms/types.js';
import type { WpPost, WpPostInput } from './api.js';

const md = new MarkdownIt({
  html: true,
  linkify: false,
  breaks: false,
  typographer: false,
});

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
    code: ['class'],
    th: ['scope', 'colspan', 'rowspan'],
    td: ['colspan', 'rowspan'],
    time: ['datetime'],
    abbr: ['title'],
    blockquote: ['cite'],
    q: ['cite'],
    '*': ['id', 'class'],
  },
  allowedSchemes: ['https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['https', 'data'] },
  disallowedTagsMode: 'discard',
};

export interface MarkdownToHtmlOptions {
  /** When true, skip sanitization and pass raw HTML through. Default false. */
  trustVaultContent?: boolean;
}

function decodeHtmlEntities(html: string): string {
  return html
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#8216;/g, '‘')
    .replace(/&#8217;/g, '’')
    .replace(/&#8220;/g, '“')
    .replace(/&#8221;/g, '”')
    .replace(/&#8230;/g, '…')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

function mapWpStatus(
  status: WpPost['status'],
): 'published' | 'draft' | 'scheduled' {
  switch (status) {
    case 'publish': return 'published';
    case 'future': return 'scheduled';
    default: return 'draft';
  }
}

export function wpPostToRemotePost(
  post: WpPost,
  tagNames: Map<number, string>,
  categoryNames: Map<number, string>,
  mediaUrl: string | null,
  kind: ContentKind = 'post',
): RemoteContentItem {
  const status = mapWpStatus(post.status);

  const tags: string[] = [
    ...post.tags.map((id) => tagNames.get(id) ?? String(id)),
    ...post.categories.map((id) => `cat:${categoryNames.get(id) ?? String(id)}`),
  ];

  const excerptPlain = htmlToPlainText(post.excerpt.rendered);
  const summary = excerptPlain.length > 0 ? excerptPlain : null;

  return {
    kind,
    id: String(post.id),
    slug: post.slug,
    title: decodeHtmlEntities(post.title.rendered),
    body: htmlToMarkdown(post.content.rendered),
    status,
    tags,
    summary,
    featureImage: mediaUrl,
    author: null,
    updatedAt: post.modified_gmt,
    createdAt: post.date_gmt,
    publishedAt: post.status === 'publish' ? post.date_gmt : null,
    container: null,
    url: status === 'published' ? post.link : null,
  };
}

export function markdownToWpHtml(
  markdown: string,
  options: MarkdownToHtmlOptions = {},
): string {
  const raw = md.render(markdown).trim();
  if (options.trustVaultContent) return raw;
  return sanitizeHtml(raw, SAFE_HTML_OPTIONS);
}

export function remotePostToWpInput(
  input: CreatePostInput | UpdatePostInput,
  /**
   * Resolved WP category IDs. Pass `undefined` (not `[]`) to omit the field
   * entirely — WP REST clears categories when `categories: []` is sent, so
   * callers must explicitly signal "no change" via undefined.
   */
  categoryIds: number[] | undefined,
  /**
   * Resolved WP tag IDs. Same semantics as `categoryIds` — undefined = omit.
   */
  tagIds: number[] | undefined,
  options: MarkdownToHtmlOptions = {},
): WpPostInput {
  const out: WpPostInput = {};

  if (input.title !== undefined) out.title = input.title;
  if (input.slug !== undefined) out.slug = input.slug;
  if (input.body !== undefined) out.content = markdownToWpHtml(input.body, options);
  if (input.summary !== undefined) out.excerpt = input.summary ?? undefined;

  if (input.status !== undefined) {
    switch (input.status) {
      case 'published': out.status = 'publish'; break;
      case 'scheduled': out.status = 'future'; break;
      default: out.status = input.status;
    }
  }

  if (categoryIds !== undefined) out.categories = categoryIds;
  if (tagIds !== undefined) out.tags = tagIds;

  return out;
}
