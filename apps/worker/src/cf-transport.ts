import ipaddr from 'ipaddr.js';
import {
  isPublicUnicast,
  normalizeHostname,
  parsePublicHttpUrl,
  RetryableNetworkError,
  sanitizeSensitiveText,
  SsrfBlockedError,
  UnknownNetworkError,
  type HttpPostOptions,
  type HttpRequestOptions,
  type HttpResponse,
  type HttpTransport,
} from '@tickbell/core';

const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const DOH_TIMEOUT_MS = 3_000;

/**
 * Trusted official notification gateways that are guaranteed public internet endpoints.
 * Skipping redundant DoH lookups for these hosts preserves Cloudflare Workers Free Plan's
 * 50-subrequest per-invocation budget during Cron ticks.
 */
const TRUSTED_PUBLIC_GATEWAY_HOSTS = new Set([
  'api.day.app',
  'api.telegram.org',
  'qyapi.weixin.qq.com',
  'oapi.dingtalk.com',
  'open.feishu.cn',
  'open.larksuite.com',
  'sctapi.ftqq.com',
]);

function isTrustedPublicGateway(hostname: string): boolean {
  if (TRUSTED_PUBLIC_GATEWAY_HOSTS.has(hostname)) return true;
  if (/^\d+\.push\.ft07\.com$/.test(hostname)) return true;
  return false;
}

interface DohAnswer {
  type?: number;
  data?: string;
}

interface DohResponse {
  Status?: number;
  Answer?: DohAnswer[];
}

async function queryDohRecord(hostname: string, type: 'A' | 'AAAA', signal: AbortSignal): Promise<string[]> {
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/dns-json' },
    redirect: 'manual',
    signal,
  });
  if (!res.ok) {
    throw new RetryableNetworkError(`DNS 预检失败（HTTP ${res.status}）`);
  }
  const data = (await res.json()) as DohResponse;
  if (typeof data.Status !== 'number') {
    throw new RetryableNetworkError('DNS 预检返回无效响应');
  }
  if (data.Status === 3) {
    // NXDOMAIN for this address family or domain
    return [];
  }
  if (data.Status !== 0) {
    throw new RetryableNetworkError(`DNS 预检返回错误状态（${data.Status}）`);
  }
  const expectedType = type === 'A' ? 1 : 28;
  return (data.Answer ?? [])
    .filter((ans) => ans.type === expectedType && typeof ans.data === 'string' && ipaddr.isValid(ans.data))
    .map((ans) => ans.data!);
}

async function verifyPublicHostViaDoh(hostname: string): Promise<void> {
  if (ipaddr.isValid(hostname)) {
    if (!isPublicUnicast(hostname)) {
      throw new SsrfBlockedError('通知地址不能指向私有或非公网 IP');
    }
    return;
  }
  if (isTrustedPublicGateway(hostname)) {
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOH_TIMEOUT_MS);
  try {
    const [aRecords, aaaaRecords] = await Promise.all([
      queryDohRecord(hostname, 'A', controller.signal),
      queryDohRecord(hostname, 'AAAA', controller.signal),
    ]);
    const addresses = [...aRecords, ...aaaaRecords];
    if (addresses.length === 0) {
      throw new RetryableNetworkError('通知地址 DNS 未返回可用公网记录，已停止发送');
    }
    if (addresses.some((addr) => !isPublicUnicast(addr))) {
      throw new SsrfBlockedError('通知地址解析到私有或非公网地址，已停止发送');
    }
  } catch (error) {
    if (error instanceof SsrfBlockedError || error instanceof RetryableNetworkError) {
      throw error;
    }
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw new RetryableNetworkError('通知地址 DNS 预检超时，已停止发送');
    }
    throw new RetryableNetworkError('通知地址 DNS 预检失败，已停止发送');
  } finally {
    clearTimeout(timer);
  }
}

async function cfRequest(options: HttpRequestOptions): Promise<HttpResponse> {
  let normalizedUrl: string;
  try {
    normalizedUrl = parsePublicHttpUrl(options.url, '通知地址', options.policy);
  } catch (error) {
    throw new SsrfBlockedError(error instanceof Error ? error.message : '通知地址不合法');
  }

  const hostname = normalizeHostname(new URL(normalizedUrl).hostname);
  await verifyPublicHostViaDoh(hostname);

  const timeoutMs = options.timeoutMs ?? 15_000;
  const method = options.method ?? 'POST';

  try {
    const response = await fetch(normalizedUrl, {
      method,
      redirect: 'manual',
      headers: options.headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : options.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } catch (error) {
    if (error instanceof SsrfBlockedError || error instanceof RetryableNetworkError) {
      throw error;
    }
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new UnknownNetworkError('通知请求超时，发送状态未知');
    }
    const rawMessage = error instanceof Error ? error.message : String(error);
    throw new UnknownNetworkError(sanitizeSensitiveText(rawMessage));
  }
}

export function createCfHttpTransport(): HttpTransport {
  return {
    request: cfRequest,
    post: (options: HttpPostOptions) =>
      cfRequest({
        url: options.url,
        method: options.method ?? 'POST',
        headers: options.headers,
        body: options.body,
        timeoutMs: options.timeoutMs,
        policy: options.policy,
      }),
  };
}
