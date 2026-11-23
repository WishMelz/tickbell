import * as dns from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { Agent, fetch as undiciFetch, type Response as UndiciResponse } from 'undici';
import ipaddr from 'ipaddr.js';
import { ValidationError } from '../../../common/errors';
import type { NotificationErrorClass, NotificationResult } from '../channel-provider.interface';
import { isPublicUnicast, normalizeHostname, parsePublicHttpUrl, PrivateNetworkPolicy } from './url-policy';

export interface PinnedPostOptions {
  url: string;
  method?: 'POST' | 'PUT';
  headers?: Record<string, string>;
  body: string;
  timeoutMs?: number;
  policy: PrivateNetworkPolicy;
}

export interface PinnedHttpResponse {
  ok: boolean;
  status: number;
  text: string;
}

export type HttpPostFn = (options: PinnedPostOptions) => Promise<PinnedHttpResponse>;

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

export class RetryableNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableNetworkError';
  }
}

export class UnknownNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownNetworkError';
  }
}

const RETRYABLE_ERR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** Redacts secret tokens/keys in URLs or error text before writing to logs or delivery error fields. */
export function sanitizeSensitiveText(text: string): string {
  return text
    .replace(/\/bot\d+:[A-Za-z0-9_-]+/g, '/bot[REDACTED]')
    .replace(/(\/bot\/v2\/hook\/)[A-Za-z0-9_-]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:key|access_token|token|secret|sign|sendkey)=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/(\/send\/)sct[a-z0-9_-]+(\.send)/gi, '$1[REDACTED]$2')
    .replace(/(\/)sct[a-z0-9_-]+(\.send)/gi, '$1[REDACTED]$2');
}

function extractErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const err = error as { code?: unknown; cause?: unknown };
  if (typeof err.code === 'string') return err.code;
  if (err.cause) return extractErrorCode(err.cause);
  return undefined;
}

function isTlsError(code: string | undefined, message: string): boolean {
  if (code && (code.startsWith('ERR_TLS_') || code.startsWith('CERT_') || code.includes('TLS') || code.includes('SSL'))) {
    return true;
  }
  return /certificate|tls|ssl|handshake/i.test(message);
}

/**
 * Resolves `hostname` via OS DNS, verifies every returned address is public unicast (unless allowed by `policy`),
 * and returns the validated LookupAddress list so the caller can pin the TCP socket to those exact IPs.
 */
export async function resolveAndValidateHost(
  rawUrl: string,
  policy: PrivateNetworkPolicy,
): Promise<{ url: string; addresses: LookupAddress[] | null }> {
  let normalizedUrl: string;
  try {
    normalizedUrl = parsePublicHttpUrl(rawUrl, '通知地址', policy);
  } catch (error) {
    throw new SsrfBlockedError(error instanceof Error ? error.message : '通知地址不合法');
  }

  const parsed = new URL(normalizedUrl);
  const hostname = normalizeHostname(parsed.hostname);

  // Self-hosted private-network mode: trust OS resolver directly (supports Docker service names, LAN hosts, localhost)
  if (policy.allowPrivate || ipaddr.isValid(hostname)) {
    return { url: normalizedUrl, addresses: null };
  }

  let resolved: LookupAddress[];
  try {
    resolved = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    const code = extractErrorCode(error);
    throw new RetryableNetworkError(`通知地址 DNS 解析失败${code ? `（${code}）` : ''}，已停止发送`);
  }

  if (!resolved.length) {
    throw new RetryableNetworkError('通知地址 DNS 未返回可用记录，已停止发送');
  }

  if (!policy.isHostAllowed(hostname)) {
    const hasBlocked = resolved.some(
      (item) => !isPublicUnicast(item.address) && !policy.isAddressAllowed(item.address),
    );
    if (hasBlocked) {
      throw new SsrfBlockedError('通知地址解析到私有或非公网地址，已停止发送');
    }
  }

  return { url: normalizedUrl, addresses: resolved };
}

/**
 * Performs an HTTP POST/PUT request with optional DNS pinning (when strict public-only mode is enabled)
 * and classifies network failures into retryable vs permanent vs unknown.
 */
export async function pinnedHttpPost(options: PinnedPostOptions): Promise<PinnedHttpResponse> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const method = options.method ?? 'POST';
  const { url, addresses } = await resolveAndValidateHost(options.url, options.policy);

  const agent = addresses
    ? new Agent({
        connectTimeout: Math.min(timeoutMs, 10_000),
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
        connect: {
          lookup: (_hostname, lookupOpts, callback) => {
            if (lookupOpts && typeof lookupOpts === 'object' && lookupOpts.all) {
              callback(null, addresses);
              return;
            }
            const family = lookupOpts && typeof lookupOpts === 'object' ? lookupOpts.family : undefined;
            const match = family ? addresses.find((item) => item.family === family) : addresses[0];
            const chosen = match ?? addresses[0]!;
            callback(null, chosen.address, chosen.family);
          },
        },
      })
    : new Agent({
        connectTimeout: Math.min(timeoutMs, 10_000),
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });

  try {
    const response: UndiciResponse = await undiciFetch(url, {
      method,
      redirect: 'manual',
      headers: options.headers,
      body: options.body,
      dispatcher: agent,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } catch (error) {
    const code = extractErrorCode(error);
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = sanitizeSensitiveText(rawMessage);
    if (error instanceof SsrfBlockedError || error instanceof ValidationError) {
      throw new SsrfBlockedError(message);
    }
    if (code && RETRYABLE_ERR_CODES.has(code)) {
      throw new RetryableNetworkError(message);
    }
    if (isTlsError(code, message)) {
      throw new RetryableNetworkError(message);
    }
    if (
      (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'))
      || code === 'UND_ERR_HEADERS_TIMEOUT'
      || code === 'UND_ERR_BODY_TIMEOUT'
    ) {
      throw new UnknownNetworkError('通知请求超时，发送状态未知');
    }
    throw new UnknownNetworkError(message);
  } finally {
    await agent.close().catch(() => undefined);
  }
}

export function classifyHttpStatus(status: number): NotificationErrorClass {
  if (status === 429 || status === 502 || status === 503 || status === 504) return 'retryable';
  if (status >= 400 && status < 500) return 'permanent';
  return 'unknown';
}

export interface EvaluatedBody {
  ok: boolean;
  error: string | null;
  errorClass?: NotificationErrorClass;
}

export function resultFromHttpResponse(
  response: PinnedHttpResponse,
  evaluate?: (body: unknown) => EvaluatedBody,
): NotificationResult {
  const responseSummary = sanitizeSensitiveText(response.text.slice(0, 1000));
  let evaluation: EvaluatedBody | null = null;
  if (evaluate && response.status >= 200 && response.status < 300) {
    try {
      evaluation = evaluate(JSON.parse(response.text));
    } catch {
      evaluation = { ok: false, error: '通知服务返回了无效的 JSON 响应', errorClass: 'permanent' };
    }
  } else if (evaluate && response.text.trim().startsWith('{')) {
    try {
      evaluation = evaluate(JSON.parse(response.text));
    } catch {
      // fall through to HTTP status
    }
  }

  const ok = response.ok && (evaluation?.ok ?? true);
  if (ok) {
    return {
      ok: true,
      httpStatus: response.status,
      responseSummary,
      error: null,
    };
  }

  const errorClass: NotificationErrorClass =
    evaluation?.errorClass ?? (response.ok ? 'permanent' : classifyHttpStatus(response.status));
  return {
    ok: false,
    httpStatus: response.status,
    responseSummary,
    error: sanitizeSensitiveText(evaluation?.error || `HTTP ${response.status}`),
    errorClass,
  };
}

export function resultFromError(error: unknown): NotificationResult {
  const message = sanitizeSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 1000);
  if (error instanceof SsrfBlockedError || error instanceof ValidationError) {
    return { ok: false, httpStatus: null, responseSummary: '', error: message, errorClass: 'permanent' };
  }
  if (error instanceof RetryableNetworkError) {
    return { ok: false, httpStatus: null, responseSummary: '', error: message, errorClass: 'retryable' };
  }
  return { ok: false, httpStatus: null, responseSummary: '', error: message, errorClass: 'unknown' };
}
