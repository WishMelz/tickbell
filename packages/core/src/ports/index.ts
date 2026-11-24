import type { PrivateNetworkPolicy } from '../notifications/http/url-policy';

export interface SqlStatement {
  sql: string;
  params?: readonly unknown[];
}

export interface DbRunResult {
  changes: number;
}

/**
 * Platform-agnostic async SQL adapter.
 * - Cloudflare Workers maps `batch` / `batchQuery` directly to `D1Database.batch()` (counts as 1 D1 query).
 * - Node.js wraps `batch` / `batchQuery` in a synchronous `better-sqlite3` transaction.
 */
export interface DbAdapter {
  /** Safe maximum bound parameters per single SQL statement (D1: 90, SQLite: 500). */
  readonly maxBindParams: number;
  all<T = Record<string, unknown>>(stmt: SqlStatement): Promise<T[]>;
  first<T = Record<string, unknown>>(stmt: SqlStatement): Promise<T | null>;
  run(stmt: SqlStatement): Promise<DbRunResult>;
  batch(stmts: readonly SqlStatement[]): Promise<DbRunResult[]>;
  batchQuery<T = Record<string, unknown>>(stmts: readonly SqlStatement[]): Promise<T[][]>;
  ping(): Promise<boolean>;
}

export const PROXY_PROTOCOLS = ['http', 'https', 'socks5'] as const;
export type ProxyProtocol = (typeof PROXY_PROTOCOLS)[number];

export interface ProxyTarget {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface HttpRequestOptions {
  url: string;
  method?: 'GET' | 'HEAD' | 'POST' | 'PUT';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  policy: PrivateNetworkPolicy;
  proxy?: ProxyTarget | null;
}

export interface HttpPostOptions {
  url: string;
  method?: 'POST' | 'PUT';
  headers?: Record<string, string>;
  body: string;
  timeoutMs?: number;
  policy: PrivateNetworkPolicy;
  proxy?: ProxyTarget | null;
}

export interface HttpResponse {
  ok: boolean;
  status: number;
  text: string;
}

export type HttpRequestFn = (options: HttpRequestOptions) => Promise<HttpResponse>;
export type HttpPostFn = (options: HttpPostOptions) => Promise<HttpResponse>;

export interface HttpTransport {
  request: HttpRequestFn;
  post: HttpPostFn;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
  unavailable?: boolean;
}

export interface RateLimiter {
  limit(key: string): Promise<RateLimitResult>;
}

export interface AutoBackupFileInfo {
  name: string;
  sizeBytes: number;
  createdAt: string;
}

export interface AutoBackupStorage {
  readonly backupDir: string;
  listFiles(): Promise<AutoBackupFileInfo[]>;
  writeFile(name: string, content: string, now: number): Promise<AutoBackupFileInfo>;
  readFile(name: string, maxBytes: number): Promise<string | null>;
  deleteFile(name: string): Promise<boolean>;
  pruneFiles(maxFiles: number): Promise<void>;
}

export type RuntimeKind = 'cloudflare' | 'node';
export type CookieSecureMode = 'auto' | 'true' | 'false';

export interface RuntimeCapabilities {
  proxies: boolean;
  diskAutoBackup: boolean;
  sqliteVacuumBackup: boolean;
  minScheduleIntervalSec: number;
  allowPrivateUrls: boolean;
}

export interface RuntimeStatusMeta {
  version: string;
  runtime: RuntimeKind;
  runtimeLabel: string;
  startedAt: string | null;
  uptimeSeconds: number | null;
  capabilities: RuntimeCapabilities;
  schedulerEnabled: boolean;
  schedulerPaused: boolean;
  schedulerIntervalMs: number;
  sqliteBackup: {
    lastBackupAt: string | null;
    lastBackupFile: string | null;
    keepDays: number;
  };
}

export interface CoreConfig {
  version: string;
  runtime: RuntimeKind;
  /** Optional env fallback password (normal deployments initialize via Web UI). */
  adminPassword: string;
  /** Optional env fallback session secret (normal deployments initialize via Web UI). */
  sessionSecret: string;
  cookieSecure: CookieSecureMode;
  missedGraceMinutes: number;
  deliveryRetentionDays: number;
  allowPrivateUrls: boolean;
  allowedPrivateHosts: string[];
  /** Max new deliveries claimed in a single scheduler tick (protects CF Free Plan subrequest budget). */
  maxDeliveriesPerTick: number;
  /** Max retries executed in a single scheduler tick. */
  maxRetriesPerTick: number;
  /** Delivery concurrency within a tick. */
  deliveryConcurrency: number;
  /** Heartbeat staleness threshold (ms) for `/api/health`. */
  healthHeartbeatMaxAgeMs: number;
}

export interface CoreLogger {
  info(data: Record<string, unknown>, msg: string): void;
  warn(data: Record<string, unknown>, msg: string): void;
  error(data: Record<string, unknown>, msg: string): void;
}

export const consoleLogger: CoreLogger = {
  info(data, msg) {
    console.log(JSON.stringify({ level: 'info', msg, ...data }));
  },
  warn(data, msg) {
    console.warn(JSON.stringify({ level: 'warn', msg, ...data }));
  },
  error(data, msg) {
    console.error(JSON.stringify({ level: 'error', msg, ...data }));
  },
};

export const silentLogger: CoreLogger = {
  info() {},
  warn() {},
  error() {},
};
