import { ValidationError } from '../../common/errors';
import type { HttpResponse } from '../../ports/index';
import type { NotificationErrorClass, NotificationResult } from '../channel-provider.interface';

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

/** Redacts secret tokens/keys in URLs or error text before writing to logs or delivery error fields. */
export function sanitizeSensitiveText(text: string): string {
  return text
    .replace(/((?:https?|socks5h?):\/\/)([^@\s/]+)@/gi, '$1[REDACTED]@')
    .replace(/\/bot\d+:[A-Za-z0-9_-]+/g, '/bot[REDACTED]')
    .replace(/(\/bot\/v2\/hook\/)[A-Za-z0-9_-]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:key|access_token|token|secret|sign|sendkey)=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/(\/send\/)sct[a-z0-9_-]+(\.send)/gi, '$1[REDACTED]$2')
    .replace(/(\/)sct[a-z0-9_-]+(\.send)/gi, '$1[REDACTED]$2');
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
  response: HttpResponse,
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
