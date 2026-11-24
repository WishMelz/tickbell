import type { D1Database, Fetcher, RateLimit } from '@cloudflare/workers-types';

export interface WorkerEnv {
  DB: D1Database;
  ASSETS?: Fetcher;
  LOGIN_RATE_LIMITER?: RateLimit;
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
  COOKIE_SECURE?: string;
  MISSED_GRACE_MINUTES?: string;
  DELIVERY_RETENTION_DAYS?: string;
  CRON_MAX_DELIVERIES_PER_TICK?: string;
  CRON_MAX_RETRIES_PER_TICK?: string;
}
