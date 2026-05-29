import path from 'node:path';
import { CmsAdapter } from '../cms/adapter.js';
import { RemoteMediaRef } from '../cms/types.js';
import { Vault, normalizePath } from '../vault.js';
import { VaultFile } from '../types.js';

export interface AssetRewriteResult {
  markdown: string;
  uploaded: RemoteMediaRef[];
}

interface MarkdownImage {
  raw: string;
  alt: string;
  target: string;
  title?: string;
}

const IMAGE_EXTENSIONS = new Set([
  '.avif',
  '.gif',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.webp',
]);

const MIME_BY_EXT = new Map<string, string>([
  ['.avif', 'image/avif'],
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
]);

/**
 * Upload local markdown image references and rewrite them to remote URLs.
 * Remote URLs, anchors, data URIs, and missing files are left untouched.
 */
export async function uploadLocalMarkdownImages(
  vault: Vault,
  adapter: CmsAdapter,
  file: VaultFile,
  markdown: string,
): Promise<AssetRewriteResult> {
  if (!adapter.uploadMedia) return { markdown, uploaded: [] };

  const images = findMarkdownImages(markdown);
  if (images.length === 0) return { markdown, uploaded: [] };

  const byTarget = new Map<string, RemoteMediaRef>();
  const uploaded: RemoteMediaRef[] = [];
  let rewritten = markdown;

  for (const image of images) {
    if (!isLocalImageTarget(image.target)) continue;

    const assetPath = resolveAssetPath(file.path, image.target);
    if (!(await vault.exists(assetPath))) continue;

    let media = byTarget.get(assetPath);
    if (!media) {
      const bytes = await vault.readBinary(assetPath);
      const filename = path.posix.basename(assetPath);
      media = await adapter.uploadMedia({
        file: new Blob([toArrayBuffer(bytes)], { type: mimeTypeFor(filename) }),
        filename,
        mimeType: mimeTypeFor(filename),
        alt: image.alt || null,
        ref: assetPath,
        purpose: 'image',
      });
      byTarget.set(assetPath, media);
      uploaded.push(media);
    }

    rewritten = rewritten.replace(image.raw, renderMarkdownImage(image, media.url));
  }

  return { markdown: rewritten, uploaded };
}

export async function uploadLocalFeatureImage(
  vault: Vault,
  adapter: CmsAdapter,
  file: VaultFile,
  featureImage: string | null,
): Promise<{ featureImage: string | null; media: RemoteMediaRef | null }> {
  if (!featureImage || !adapter.uploadMedia || !isLocalImageTarget(featureImage)) {
    return { featureImage, media: null };
  }

  const assetPath = resolveAssetPath(file.path, featureImage);
  if (!(await vault.exists(assetPath))) return { featureImage, media: null };

  const filename = path.posix.basename(assetPath);
  const media = await adapter.uploadMedia({
    file: new Blob([toArrayBuffer(await vault.readBinary(assetPath))], {
      type: mimeTypeFor(filename),
    }),
    filename,
    mimeType: mimeTypeFor(filename),
    ref: assetPath,
    purpose: 'image',
  });
  return { featureImage: media.url, media };
}

function findMarkdownImages(markdown: string): MarkdownImage[] {
  const images: MarkdownImage[] = [];
  const re = /!\[([^\]]*)\]\((<[^>]+>|[^)\s]+)(?:\s+"([^"]*)")?\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    const rawTarget = match[2];
    images.push({
      raw: match[0],
      alt: match[1],
      target: rawTarget.startsWith('<') && rawTarget.endsWith('>')
        ? rawTarget.slice(1, -1)
        : rawTarget,
      title: match[3],
    });
  }
  return images;
}

function renderMarkdownImage(image: MarkdownImage, url: string): string {
  const title = image.title ? ` "${image.title}"` : '';
  return `![${image.alt}](${url}${title})`;
}

function isLocalImageTarget(target: string): boolean {
  const lower = target.toLowerCase();
  if (
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('//') ||
    lower.startsWith('data:') ||
    lower.startsWith('mailto:') ||
    lower.startsWith('#')
  ) {
    return false;
  }
  return IMAGE_EXTENSIONS.has(path.posix.extname(stripQueryAndHash(lower)));
}

function resolveAssetPath(markdownPath: string, target: string): string {
  const cleanTarget = decodeURIComponent(stripQueryAndHash(target));
  if (cleanTarget.startsWith('/')) return normalizePath(cleanTarget);
  const base = path.posix.dirname(markdownPath);
  return normalizePath(path.posix.join(base === '.' ? '' : base, cleanTarget));
}

function stripQueryAndHash(value: string): string {
  return value.split(/[?#]/, 1)[0];
}

function mimeTypeFor(filename: string): string {
  return MIME_BY_EXT.get(path.posix.extname(filename).toLowerCase()) ?? 'application/octet-stream';
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
