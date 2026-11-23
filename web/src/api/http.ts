/**
 * 原生 fetch 封装，约定见 docs/API.md 第 0 节：
 * 成功 { data }，失败 { error }；401 时清除登录态并跳转登录页（登录接口本身除外）。
 */

export class ApiError extends Error {
  readonly status: number;
  /** 429 时的 Retry-After（秒） */
  readonly retryAfter: number | null;

  constructor(message: string, status: number, retryAfter: number | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

/** main.ts 注册：清空 auth store 并跳转 /login */
export function onUnauthorized(handler: UnauthorizedHandler): void {
  unauthorizedHandler = handler;
}

const NO_401_REDIRECT = new Set(['/auth/login', '/auth/status', '/auth/logout']);

const STATUS_MESSAGES: Record<number, string> = {
  400: '请求参数有误',
  401: '登录已失效，请重新登录',
  403: '没有权限',
  404: '资源不存在',
  409: '操作冲突',
  413: '请求体过大',
  429: '操作过于频繁，请稍后再试',
  500: '服务器错误',
  502: '无法连接到后端服务',
  503: '服务暂不可用',
  504: '后端服务响应超时',
};

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined | null>;
  signal?: AbortSignal;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, signal } = options;
  let url = `/api${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('网络连接失败，请检查网络后重试', 0);
  }

  let payload: { data?: T; error?: string } | null = null;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text) as { data?: T; error?: string };
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    if (response.status === 401 && !NO_401_REDIRECT.has(path)) unauthorizedHandler?.();
    const retryHeader = response.headers.get('Retry-After');
    const retryAfter = retryHeader && /^\d+$/.test(retryHeader) ? Number(retryHeader) : null;
    const message = payload?.error || STATUS_MESSAGES[response.status] || `请求失败（${response.status}）`;
    throw new ApiError(message, response.status, retryAfter);
  }

  if (!payload || !('data' in payload)) {
    throw new ApiError('服务器返回了无法识别的响应', response.status);
  }
  return payload.data as T;
}

export function errorMessage(error: unknown, fallback = '操作失败'): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export function isApiError(error: unknown, status?: number): error is ApiError {
  return error instanceof ApiError && (status === undefined || error.status === status);
}
