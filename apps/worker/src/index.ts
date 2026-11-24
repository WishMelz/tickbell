import type { ExecutionContext, ScheduledController } from '@cloudflare/workers-types';
import {
  createCoreApp,
  type CookieSecureMode,
  type CoreConfig,
  type RuntimeStatusMeta,
} from '@tickbell/core';
import { CfRateLimiter } from './cf-ratelimit';
import { createCfHttpTransport } from './cf-transport';
import { D1DbAdapter } from './d1-adapter';
import type { WorkerEnv } from './env';

const APP_VERSION = '2.0.0';

function parseIntEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw || !raw.trim()) return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function parseCookieSecure(raw: string | undefined): CookieSecureMode {
  const norm = raw?.trim().toLowerCase();
  if (norm === 'true' || norm === '1') return 'true';
  if (norm === 'false' || norm === '0') return 'false';
  return 'auto';
}

export function buildWorkerCore(env: WorkerEnv) {
  const config: CoreConfig = {
    version: APP_VERSION,
    runtime: 'cloudflare',
    adminPassword: env.ADMIN_PASSWORD?.trim() ?? '',
    sessionSecret: env.SESSION_SECRET?.trim() ?? '',
    cookieSecure: parseCookieSecure(env.COOKIE_SECURE),
    missedGraceMinutes: parseIntEnv(env.MISSED_GRACE_MINUTES, 60, 0, 10_080),
    deliveryRetentionDays: parseIntEnv(env.DELIVERY_RETENTION_DAYS, 90, 1, 36_500),
    allowPrivateUrls: false,
    allowedPrivateHosts: [],
    maxDeliveriesPerTick: parseIntEnv(env.CRON_MAX_DELIVERIES_PER_TICK, 12, 1, 500),
    maxRetriesPerTick: parseIntEnv(env.CRON_MAX_RETRIES_PER_TICK, 5, 1, 200),
    deliveryConcurrency: 5,
    // Cron runs every 60s; allow 5 minutes before marking health degraded
    healthHeartbeatMaxAgeMs: 5 * 60 * 1000,
  };

  const runtimeMeta: RuntimeStatusMeta = {
    version: APP_VERSION,
    runtime: 'cloudflare',
    runtimeLabel: 'Cloudflare Workers + D1',
    startedAt: null,
    uptimeSeconds: null,
    capabilities: {
      proxies: false,
      diskAutoBackup: false,
      sqliteVacuumBackup: false,
      minScheduleIntervalSec: 60,
      allowPrivateUrls: false,
    },
    schedulerEnabled: true,
    schedulerPaused: false,
    schedulerIntervalMs: 60_000,
    sqliteBackup: {
      lastBackupAt: null,
      lastBackupFile: null,
      keepDays: 0,
    },
  };

  return createCoreApp({
    config,
    db: new D1DbAdapter(env.DB),
    http: createCfHttpTransport(),
    rateLimiter: new CfRateLimiter(env.LOGIN_RATE_LIMITER),
    getRuntimeMeta: () => runtimeMeta,
    // Cloudflare Edge sets authoritative CF-Connecting-IP and terminates HTTPS directly
    getClientIp: (c) => c.req.header('CF-Connecting-IP'),
    trustForwardedProto: false,
    fallbackHandler: async (c) => {
      if (env.ASSETS) {
        const assetResponse = await env.ASSETS.fetch(c.req.raw as unknown as Parameters<typeof env.ASSETS.fetch>[0]);
        return assetResponse as unknown as Response;
      }
      return c.json({ error: '静态资源绑定缺失' }, 404);
    },
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const { app } = buildWorkerCore(env);
    return app.fetch(request, env, ctx);
  },

  scheduled(_controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): void {
    const { scheduler } = buildWorkerCore(env);
    ctx.waitUntil(scheduler.runTick());
  },
};
