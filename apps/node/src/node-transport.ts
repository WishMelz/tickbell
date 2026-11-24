import * as dns from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import {
  isPublicUnicast,
  normalizeHostname,
  parsePublicHttpUrl,
  RetryableNetworkError,
  sanitizeSensitiveText,
  SsrfBlockedError,
  UnknownNetworkError,
  ValidationError,
  type HttpPostOptions,
  type HttpRequestOptions,
  type HttpResponse,
  type HttpTransport,
  type PrivateNetworkPolicy,
} from '@tickbell/core';
import ipaddr from 'ipaddr.js';
import { Agent, type Dispatcher, fetch as undiciFetch, type Response as UndiciResponse } from 'undici';
import { createProxyDispatcher } from './proxy-dispatcher';

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

function extractErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const err = error as { code?: unknown; cause?: unknown };
  if (typeof err.code === 'string') return err.code;
  if (err.cause) return extractErrorCode(err.cause);
  return undefined;
}

function extractErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message) {
    if (!error.message || error.message === 'fetch failed') {
      return extractErrorMessage(cause);
    }
  }
  return error.message;
}

function isTlsError(code: string | undefined, message: string): boolean {
  if (code && (code.startsWith('ERR_TLS_') || code.startsWith('CERT_') || code.includes('TLS') || code.includes('SSL'))) {
    return true;
  }
  return /certificate|tls|ssl|handshake/i.test(message);
}

async function resolveAndValidateHost(
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

export async function nodeHttpRequest(options: HttpRequestOptions): Promise<HttpResponse> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const method = options.method ?? 'POST';

  let url: string;
  let dispatcher: Dispatcher;

  if (options.proxy) {
    try {
      url = parsePublicHttpUrl(options.url, '通知地址', options.policy);
    } catch (error) {
      throw new SsrfBlockedError(error instanceof Error ? error.message : '通知地址不合法');
    }
    dispatcher = createProxyDispatcher(options.proxy, timeoutMs);
  } else {
    const resolved = await resolveAndValidateHost(options.url, options.policy);
    url = resolved.url;
    const addresses = resolved.addresses;
    dispatcher = addresses
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
  }

  try {
    const response: UndiciResponse = await undiciFetch(url, {
      method,
      redirect: 'manual',
      headers: options.headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : options.body,
      dispatcher,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } catch (error) {
    const code = extractErrorCode(error);
    const rawMessage = extractErrorMessage(error);
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
    await dispatcher.close().catch(() => undefined);
  }
}

export function createNodeHttpTransport(): HttpTransport {
  return {
    request: nodeHttpRequest,
    post: (options: HttpPostOptions) =>
      nodeHttpRequest({
        url: options.url,
        method: options.method ?? 'POST',
        headers: options.headers,
        body: options.body,
        timeoutMs: options.timeoutMs,
        policy: options.policy,
        proxy: options.proxy,
      }),
  };
}
