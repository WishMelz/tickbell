import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CookieSecureMode } from '@tickbell/core';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const blankToUndefined = (value: unknown) => (value === '' || value === null ? undefined : value);

const booleanVar = (defaultValue: boolean) =>
  z.preprocess(
    blankToUndefined,
    z
      .union([z.boolean(), z.string()])
      .optional()
      .transform((value, ctx) => {
        if (value === undefined) return defaultValue;
        if (typeof value === 'boolean') return value;
        const normalized = value.trim().toLowerCase();
        if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
        if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
        ctx.addIssue({ code: 'custom', message: `invalid boolean "${value}"` });
        return z.NEVER;
      }),
  );

const cookieSecureVar = z.preprocess(
  blankToUndefined,
  z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((value, ctx): CookieSecureMode => {
      if (value === undefined) return 'auto';
      if (typeof value === 'boolean') return value ? 'true' : 'false';
      const normalized = value.trim().toLowerCase();
      if (normalized === 'auto') return 'auto';
      if (['1', 'true', 'yes', 'on'].includes(normalized)) return 'true';
      if (['0', 'false', 'no', 'off'].includes(normalized)) return 'false';
      ctx.addIssue({ code: 'custom', message: `invalid COOKIE_SECURE "${value}"` });
      return z.NEVER;
    }),
);

const intVar = (defaultValue: number, min: number, max: number) =>
  z
    .preprocess(blankToUndefined, z.coerce.number().int().min(min).max(max).optional())
    .transform((value) => value ?? defaultValue);

const stringVar = (defaultValue: string) =>
  z
    .preprocess((value) => (value === undefined || value === null ? undefined : value), z.string().optional())
    .transform((value) => value ?? defaultValue);

const envSchema = z.object({
  NODE_ENV: z
    .preprocess(blankToUndefined, z.enum(['development', 'production', 'test']).optional())
    .transform((value) => value ?? 'development'),
  PORT: intVar(3000, 1, 65535),
  HOST: stringVar('0.0.0.0'),
  ADMIN_PASSWORD: stringVar(''),
  SESSION_SECRET: stringVar(''),
  DB_PATH: stringVar('./data/tickbell.db'),
  BACKUP_DIR: stringVar(''),
  STATIC_DIR: stringVar(''),
  MIGRATIONS_DIR: stringVar(''),
  COOKIE_SECURE: cookieSecureVar,
  TRUST_PROXY: z.preprocess(
    blankToUndefined,
    z
      .union([z.boolean(), z.string()])
      .optional()
      .transform((value, ctx) => {
        if (value === undefined) return undefined;
        if (typeof value === 'boolean') return value;
        const normalized = value.trim().toLowerCase();
        if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
        if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
        ctx.addIssue({ code: 'custom', message: `invalid boolean "${value}"` });
        return z.NEVER;
      }),
  ),
  SCHEDULER_ENABLED: booleanVar(true),
  SCHEDULER_INTERVAL_MS: intVar(15_000, 1_000, 3_600_000),
  MISSED_GRACE_MINUTES: intVar(60, 0, 10_080),
  DELIVERY_RETENTION_DAYS: intVar(90, 1, 36_500),
  BACKUP_KEEP_DAYS: intVar(14, 1, 36_500),
  BACKUP_CRON: stringVar('0 3 * * *'),
  ALLOW_PRIVATE_URLS: booleanVar(true),
  ALLOWED_PRIVATE_HOSTS: stringVar(''),
  // Preview / Demo branch defaults (enabled out of the box on the `preview` branch)
  DEMO_MODE: booleanVar(true),
  DEMO_PASSWORD: stringVar('tickbell123'),
  DEMO_MAX_REMINDERS: intVar(30, 1, 500),
  DEMO_MAX_CHANNELS: intVar(10, 1, 100),
  DEMO_MAX_TEST_CHANNELS: intVar(3, 1, 10),
  DEMO_TEST_RATE_LIMIT: intVar(10, 1, 120),
  DEMO_RESET_CRON: stringVar('0 3 * * *'),
  DEMO_RESET_TIMEZONE: stringVar('Asia/Shanghai'),
});

export interface NodeAppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  port: number;
  host: string;
  adminPassword: string;
  sessionSecret: string;
  dbPath: string;
  backupDir: string;
  staticDir: string;
  migrationsDir: string;
  cookieSecure: CookieSecureMode;
  trustProxy: boolean;
  schedulerEnabled: boolean;
  schedulerIntervalMs: number;
  missedGraceMinutes: number;
  deliveryRetentionDays: number;
  backupKeepDays: number;
  backupCron: string;
  allowPrivateUrls: boolean;
  allowedPrivateHosts: string[];
  demoMode: boolean;
  demoPassword: string;
  demoMaxReminders: number;
  demoMaxChannels: number;
  demoMaxTestChannels: number;
  demoTestRateLimit: number;
  demoResetCron: string;
  demoResetTimezone: string;
}

export function loadNodeConfig(source: Record<string, unknown> = process.env, cwd = process.cwd()): NodeAppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new Error(`Invalid environment configuration:\n  ${details.join('\n  ')}`);
  }
  const env = parsed.data;
  const dbPath = env.DB_PATH === ':memory:' ? ':memory:' : path.resolve(cwd, env.DB_PATH);
  const backupDir = env.BACKUP_DIR
    ? path.resolve(cwd, env.BACKUP_DIR)
    : dbPath === ':memory:'
      ? path.resolve(cwd, 'data/backups')
      : path.join(path.dirname(dbPath), 'backups');

  const resolveStaticDir = (): string => {
    if (env.STATIC_DIR) return path.resolve(cwd, env.STATIC_DIR);
    const candidates = [
      path.resolve(cwd, 'public'),
      path.resolve(cwd, 'web/dist'),
      path.resolve(cwd, '../../web/dist'),
      path.resolve(__dirname, '../../../web/dist'),
      path.resolve(__dirname, '../public'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(path.join(candidate, 'index.html'))) return candidate;
    }
    return path.resolve(cwd, 'public');
  };

  const demoMode = env.DEMO_MODE;
  const effectiveDemoPassword = env.ADMIN_PASSWORD.trim() || env.DEMO_PASSWORD.trim() || 'tickbell123';

  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    host: env.HOST,
    adminPassword: demoMode ? effectiveDemoPassword : env.ADMIN_PASSWORD,
    sessionSecret: env.SESSION_SECRET,
    dbPath,
    backupDir,
    staticDir: resolveStaticDir(),
    migrationsDir: env.MIGRATIONS_DIR ? path.resolve(cwd, env.MIGRATIONS_DIR) : '',
    cookieSecure: env.COOKIE_SECURE,
    trustProxy: env.TRUST_PROXY ?? env.NODE_ENV === 'production',
    // In demo/preview mode, background reminder scheduling is strictly disabled; only manual test sends are allowed.
    schedulerEnabled: demoMode ? false : env.SCHEDULER_ENABLED,
    schedulerIntervalMs: env.SCHEDULER_INTERVAL_MS,
    missedGraceMinutes: env.MISSED_GRACE_MINUTES,
    deliveryRetentionDays: env.DELIVERY_RETENTION_DAYS,
    backupKeepDays: env.BACKUP_KEEP_DAYS,
    backupCron: env.BACKUP_CRON.trim(),
    // In demo/preview mode, block private/LAN URLs to protect the test server against SSRF.
    allowPrivateUrls: demoMode ? false : env.ALLOW_PRIVATE_URLS,
    allowedPrivateHosts: demoMode
      ? []
      : env.ALLOWED_PRIVATE_HOSTS.split(',').map((s) => s.trim()).filter(Boolean),
    demoMode,
    demoPassword: effectiveDemoPassword,
    demoMaxReminders: env.DEMO_MAX_REMINDERS,
    demoMaxChannels: env.DEMO_MAX_CHANNELS,
    demoMaxTestChannels: env.DEMO_MAX_TEST_CHANNELS,
    demoTestRateLimit: env.DEMO_TEST_RATE_LIMIT,
    demoResetCron: env.DEMO_RESET_CRON.trim() || '0 3 * * *',
    demoResetTimezone: env.DEMO_RESET_TIMEZONE.trim() || 'Asia/Shanghai',
  };
}
