import TurndownService from 'turndown';

const turndown = new TurndownService({
  headingStyle: 'atx',
  hr: '---',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  fence: '```',
  emDelimiter: '*',
  strongDelimiter: '**',
  linkStyle: 'inlined',
});

turndown.addRule('ghostCard', {
  filter: (node) => {
    const el = node as unknown as { classList?: { contains: (s: string) => boolean } };
    return !!(
      el.classList?.contains('kg-card') ||
      el.classList?.contains('kg-embed-card') ||
      el.classList?.contains('kg-gallery-card') ||
      el.classList?.contains('kg-bookmark-card')
    );
  },
  replacement: (_content, node) => `\n\n${(node as unknown as { outerHTML: string }).outerHTML}\n\n`,
});

turndown.addRule('codeBlock', {
  filter: (node) => {
    const n = node as unknown as { nodeName: string; firstChild?: { nodeName: string } };
    return n.nodeName === 'PRE' && n.firstChild?.nodeName === 'CODE';
  },
  replacement: (_content, node) => {
    const el = node as unknown as {
      querySelector: (s: string) => { className: string; textContent: string | null } | null;
    };
    const codeNode = el.querySelector('code');
    if (!codeNode) return '';
    const langClass = codeNode.className.match(/language-(\w+)/);
    const language = langClass ? langClass[1] : '';
    const code = codeNode.textContent || '';
    return `\n\n\`\`\`${language}\n${code}\n\`\`\`\n\n`;
  },
});

turndown.addRule('figure', {
  filter: 'figure',
  replacement: (_content, node) => {
    const fig = node as unknown as {
      querySelector: (s: string) => {
        getAttribute: (k: string) => string | null;
        textContent: string | null;
      } | null;
    };
    const img = fig.querySelector('img');
    const figcaption = fig.querySelector('figcaption');
    if (!img) return '';
    const src = img.getAttribute('src') || '';
    const alt = img.getAttribute('alt') || '';
    const caption = figcaption?.textContent || '';
    if (caption) return `\n\n![${alt || caption}](${src})\n*${caption}*\n\n`;
    return `\n\n![${alt}](${src})\n\n`;
  },
});

export function htmlToMarkdown(html: string | null): string {
  if (!html) return '';
  try {
    const cleaned = html.replace(/<p>\s*<\/p>/g, '').replace(/\r\n/g, '\n');
    const md = turndown.turndown(cleaned);
    return md.replace(/\n{3,}/g, '\n\n').trim();
  } catch (err) {
    console.error('htmlToMarkdown failed:', err);
    return html;
  }
}

export function cleanMarkdownForGhost(markdown: string): string {
  return markdown
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

export function htmlToPlainText(html: string | null, maxLength = 300): string {
  if (!html) return '';
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length > maxLength) return text.slice(0, maxLength).trim() + '...';
  return text;
}
