/**
 * 提醒正文（富文本）工具：与服务端白名单保持一致（p br strong b em i u s del blockquote ul ol li a[href]）。
 * 前端过滤只是为了编辑体验和字数统计；最终以服务端过滤结果为准。
 * 使用 DOMParser（不执行脚本、不加载资源），不引入额外依赖。
 */

export const CONTENT_TEXT_LIMIT = 4000;
export const CONTENT_HTML_LIMIT = 64000;

const ALLOWED_TAGS = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'blockquote', 'ul', 'ol', 'li', 'a']);
const DROP_WITH_BODY = new Set(['script', 'style', 'iframe', 'object', 'svg', 'math', 'template', 'noscript', 'head', 'title']);
const BLOCK_TAGS = new Set(['p', 'blockquote', 'ul', 'ol', 'li']);

export function safeContentLink(value: string): string | null {
  try {
    const url = new URL(value);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');
}

function cleanNode(node: Node, doc: Document, out: Node): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      out.appendChild(doc.createTextNode(child.textContent ?? ''));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const element = child as Element;
    const tag = element.tagName.toLowerCase();
    if (DROP_WITH_BODY.has(tag)) continue;
    if (!ALLOWED_TAGS.has(tag)) {
      cleanNode(element, doc, out); // 去掉标签、保留内容
      continue;
    }
    const clean = doc.createElement(tag);
    if (tag === 'a') {
      const href = safeContentLink(element.getAttribute('href') ?? '');
      if (href) {
        clean.setAttribute('href', href);
        clean.setAttribute('target', '_blank');
        clean.setAttribute('rel', 'noopener noreferrer');
      }
    }
    out.appendChild(clean);
    cleanNode(element, doc, clean);
  }
}

export function sanitizeContentHtml(html: string): string {
  if (!html) return '';
  const source = parse(html);
  const target = document.implementation.createHTMLDocument('');
  const container = target.createElement('div');
  cleanNode(source.body, target, container);
  return container.innerHTML;
}

/** 与服务端 contentHtmlToText 规则一致：块级元素换行，列表项前加 "- "，链接文本后附 (href) */
export function contentHtmlToText(html: string): string {
  if (!html) return '';
  const doc = parse(html);
  let text = '';
  const newLine = () => {
    if (text && !text.endsWith('\n')) text += '\n';
  };
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        text += child.textContent ?? '';
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const element = child as Element;
      const tag = element.tagName.toLowerCase();
      if (DROP_WITH_BODY.has(tag)) continue;
      if (BLOCK_TAGS.has(tag)) newLine();
      if (tag === 'br') text += '\n';
      if (tag === 'li') text += '- ';
      const start = text.length;
      walk(element);
      if (tag === 'a') {
        const href = element.getAttribute('href') ?? '';
        if (href && text.slice(start) !== href) text += ` (${href})`;
      }
      if (BLOCK_TAGS.has(tag)) newLine();
    }
  };
  walk(doc.body);
  return text.trim();
}

export function plainTextToContentHtml(value: string): string {
  if (!value) return '';
  const escaped = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<p>${escaped.replace(/\r\n|\r|\n/g, '<br>')}</p>`;
}
