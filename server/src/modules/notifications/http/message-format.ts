import { Parser } from 'htmlparser2';
import { formatInTimezone } from '../../../common/time';
import type { NotificationMessage } from '../channel-provider.interface';

export function formatTimeLine(message: NotificationMessage, includeTimezone = false): string {
  const scheduledText = formatInTimezone(message.scheduledAt, message.timezone);
  const tzSuffix = includeTimezone ? ` (${message.timezone})` : '';
  return message.isLate
    ? `原定 ${scheduledText}${tzSuffix}，延迟送达`
    : `提醒时间：${scheduledText}${tzSuffix}`;
}

/**
 * Truncates text to at most `maxChars` UTF-16 code units without splitting surrogate pairs (emoji).
 */
export function truncateByChars(text: string, maxChars: number, suffix = '\n[内容已截断]'): string {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  if (maxChars <= suffix.length) {
    return text.slice(0, maxChars).replace(/[\uD800-\uDBFF]$/, '');
  }
  const sliced = text.slice(0, maxChars - suffix.length).replace(/[\uD800-\uDBFF]$/, '');
  return `${sliced}${suffix}`;
}

/**
 * Truncates text so its UTF-8 byte length does not exceed `maxBytes` without corrupting multi-byte characters.
 */
export function truncateByUtf8Bytes(text: string, maxBytes: number, suffix = '\n[内容已截断]'): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;

  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  const budget = Math.max(0, maxBytes - suffixBytes);
  let out = '';
  let used = 0;

  for (const ch of text) {
    const chBytes = Buffer.byteLength(ch, 'utf8');
    if (used + chBytes > budget) break;
    out += ch;
    used += chBytes;
  }

  return budget > 0 ? `${out}${suffix}` : out;
}

/** Parses comma/Chinese-comma/newline separated tokens into a deduplicated string array. */
export function parseCommaList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(/[,，\n\r]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

/** Ensures a required robot security keyword appears in either title or content. */
export function ensureKeyword(
  title: string,
  content: string,
  keyword: string | undefined,
): { title: string; content: string } {
  const kw = keyword?.trim();
  if (!kw) return { title, content };
  if (title.includes(kw) || content.includes(kw)) {
    return { title, content };
  }
  return { title: `[${kw}] ${title}`, content };
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Escapes raw text to HTML while ensuring the final UTF-16 length never exceeds `maxEscapedChars`,
 * without splitting HTML entities (`&amp;`) or UTF-16 surrogate pairs (emoji).
 */
export function escapeAndTruncateHtml(
  rawText: string,
  maxEscapedChars: number,
  suffix = '\n[内容已截断]',
): string {
  if (maxEscapedChars <= 0) return '';
  const full = escapeHtml(rawText);
  if (full.length <= maxEscapedChars) return full;

  const escapedSuffix = escapeHtml(suffix);
  const useSuffix = maxEscapedChars > escapedSuffix.length;
  const budget = useSuffix ? maxEscapedChars - escapedSuffix.length : maxEscapedChars;
  let out = '';

  for (const ch of rawText) {
    const escapedCh = escapeHtml(ch);
    if (out.length + escapedCh.length > budget) break;
    out += escapedCh;
  }

  return useSuffix ? `${out}${escapedSuffix}` : out;
}

const SAFE_TELEGRAM_HREF_RE = /^(?:https?:\/\/|mailto:|tg:\/\/)/i;

/**
 * Converts sanitized reminder HTML into Telegram Bot API HTML subset
 * (`b`, `strong`, `i`, `em`, `u`, `s`, `del`, `blockquote`, `a[href]`).
 */
export function contentHtmlToTelegramHtml(html: string): string {
  let out = '';
  const openTagStack: string[] = [];
  const newLine = () => {
    if (out && !out.endsWith('\n')) out += '\n';
  };

  const inlineMap: Record<string, string> = {
    b: 'b',
    strong: 'b',
    i: 'i',
    em: 'i',
    u: 'u',
    s: 's',
    del: 's',
  };

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name === 'br') {
          out += '\n';
          return;
        }
        if (name === 'p' || name === 'ul' || name === 'ol') {
          newLine();
          return;
        }
        if (name === 'li') {
          newLine();
          out += '• ';
          return;
        }
        if (name === 'blockquote') {
          newLine();
          out += '<blockquote>';
          openTagStack.push('blockquote');
          return;
        }
        if (name === 'a' && attrs.href && SAFE_TELEGRAM_HREF_RE.test(attrs.href.trim())) {
          out += `<a href="${escapeHtml(attrs.href.trim())}">`;
          openTagStack.push('a');
          return;
        }
        const mapped = inlineMap[name];
        if (mapped) {
          out += `<${mapped}>`;
          openTagStack.push(mapped);
        }
      },
      ontext(chunk) {
        out += escapeHtml(chunk);
      },
      onclosetag(name) {
        if (name === 'p' || name === 'ul' || name === 'ol' || name === 'li') {
          newLine();
          return;
        }
        const target = name === 'blockquote' ? 'blockquote' : name === 'a' ? 'a' : inlineMap[name];
        if (target && openTagStack[openTagStack.length - 1] === target) {
          openTagStack.pop();
          out += `</${target}>`;
          if (target === 'blockquote') newLine();
        }
      },
    },
    { decodeEntities: true },
  );

  parser.end(html);
  while (openTagStack.length) {
    out += `</${openTagStack.pop()}>`;
  }
  return out.trim();
}

/** Extracts `protocol//host` from a URL for compact display without exposing query tokens. */
export function hostSummaryFromUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return rawUrl;
  }
}
