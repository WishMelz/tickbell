import { Parser } from 'htmlparser2';
import xssDefault from 'xss';

// `xss` is a CommonJS package; default import avoids Node ESM named-export errors under `tsx` while keeping full types.
const { FilterXSS, escapeAttrValue } = xssDefault as unknown as typeof import('xss');

export const CONTENT_TEXT_LIMIT = 4000;
export const CONTENT_HTML_LIMIT = 64000;

export function safeContentLink(value: string): string | null {
  try {
    const url = new URL(value);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

const filter = new FilterXSS({
  whiteList: {
    p: [],
    br: [],
    strong: [],
    b: [],
    em: [],
    i: [],
    u: [],
    s: [],
    del: [],
    blockquote: [],
    ul: [],
    ol: [],
    li: [],
    a: [],
  },
  stripIgnoreTag: true,
  stripIgnoreTagBody: ['script', 'style', 'iframe', 'object', 'svg', 'math', 'template'],
  onTagAttr(tag, name, value) {
    if (tag !== 'a' || name !== 'href') return '';
    const href = safeContentLink(value);
    return href ? `href="${escapeAttrValue(href)}" target="_blank" rel="noopener noreferrer"` : '';
  },
});

export function sanitizeContentHtml(value: string): string {
  return filter.process(value);
}

export function contentHtmlToText(value: string): string {
  let text = '';
  const links: Array<{ href: string; start: number }> = [];
  const newLine = () => {
    if (text && !text.endsWith('\n')) text += '\n';
  };
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (['p', 'blockquote', 'ul', 'ol', 'li'].includes(name)) newLine();
        if (name === 'br') text += '\n';
        if (name === 'li') text += '- ';
        if (name === 'a') links.push({ href: attributes.href ?? '', start: text.length });
      },
      ontext(chunk) {
        text += chunk;
      },
      onclosetag(name) {
        if (name === 'a') {
          const link = links.pop();
          if (link?.href && text.slice(link.start) !== link.href) text += ` (${link.href})`;
        }
        if (['p', 'blockquote', 'ul', 'ol', 'li'].includes(name)) newLine();
      },
    },
    { decodeEntities: true },
  );
  parser.end(value);
  return text.trim();
}

export function plainTextToContentHtml(value: string): string {
  const escaped = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<p>${escaped.replace(/\r\n|\r|\n/g, '<br>')}</p>`;
}
