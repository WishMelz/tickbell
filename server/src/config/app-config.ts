import * as path from 'node:path';
import { z } from 'zod';

/**
 * Environment variables → typed AppConfig.
 * Designed for zero-config self-deployment: admin password & session secret are initialized
 * in the web UI on first boot and persisted in SQLite (`settings`), so production deployments
 * do not need secret env vars.
 */

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
      ctx.addIssue({ code: 'custom', message: `invalid COOKIE_SECURE "${value}" (expected auto|true|false)` });
      return z.NEVER;
    }),
);

const intVar = (defaultValue: number, min: number, max: number) =>
  z.preprocess(blankToUndefined, z.coerce.number().int().min(min).max(max).optional())
    .transform((value) => value ?? defaultValue);

const stringVar = (defaultValue: string) =>
  z.preprocess((value) => (value === undefined || value === null ? undefined : value), z.string().optional())
    .transform((value) => value ?? defaultValue);

export type CookieSecureMode = 'auto' | 'true' | 'false';
export type TrustProxySetting = boolean | number | string;

export const envSchema = z
  .object({
    NODE_ENV: z.preprocess(blankToUndefined, z.enum(['development', 'production', 'test']).optional())
      .transform((value) => value ?? 'development'),
    PORT: intVar(3000, 1, 65535),
    HOST: stringVar('0.0.0.0'),
    // Optional overrides/test helpers — production uses first-run UI setup stored in SQLite
    ADMIN_PASSWORD: stringVar(''),
    SESSION_SECRET: stringVar(''),
    DB_PATH: stringVar('./data/tickbell.db'),
    BACKUP_DIR: stringVar(''),
    STATIC_DIR: stringVar('./public'),
    TRUST_PROXY: z.preprocess(blankToUndefined, z.string().optional()),
    COOKIE_SECURE: cookieSecureVar,
    SCHEDULER_ENABLED: booleanVar(true),
    SCHEDULER_INTERVAL_MS: intVar(15_000, 1_000, 3_600_000),
    MISSED_GRACE_MINUTES: intVar(60, 0, 10_080),
    MAX_REMINDERS: intVar(500, 1, 100_000),
    DELIVERY_RETENTION_DAYS: intVar(90, 1, 36_500),
    BACKUP_KEEP_DAYS: intVar(14, 1, 36_500),
    BACKUP_CRON: stringVar('0 3 * * *'),
    // Self-hosted notification channels (e.g. local/LAN bark-server) are allowed by default
    ALLOW_PRIVATE_URLS: booleanVar(true),
    ALLOWED_PRIVATE_HOSTS: stringVar(''),
    LOG_LEVEL: z.preprocess(
      blankToUndefined,
      z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
    ),
  })
  .superRefine((env, ctx) => {
    if (env.BACKUP_CRON.trim().split(/\s+/).length < 5) {
      ctx.addIssue({ code: 'custom', path: ['BACKUP_CRON'], message: 'BACKUP_CRON must be a cron expression' });
    }
  });

export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  port: number;
  host: string;
  /** Optional env fallback (normal deployments set password on first boot via Web UI). */
  adminPassword: string;
  /** Optional env fallback (normal deployments set session secret on first boot via Web UI). */
  sessionSecret: string;
  /** Absolute path, or ':memory:' */
  dbPath: string;
  backupDir: string;
  staticDir: string;
  trustProxy: TrustProxySetting;
  cookieSecure: CookieSecureMode;
  schedulerEnabled: boolean;
  schedulerIntervalMs: number;
  missedGraceMinutes: number;
  maxReminders: number;
  deliveryRetentionDays: number;
  backupKeepDays: number;
  backupCron: string;
  /** When true (default), self-hosted LAN/localhost notification URLs are permitted. */
  allowPrivateUrls: boolean;
  /** Allowlist used when `allowPrivateUrls` is false. */
  allowedPrivateHosts: string[];
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
}

export const APP_CONFIG = Symbol('APP_CONFIG');

function parseTrustProxy(raw: string): TrustProxySetting {
  const value = raw.trim();
  if (value === '' || value === '0' || value.toLowerCase() === 'false') return false;
  if (value.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

export class ConfigValidationError extends Error {}

export function loadAppConfig(source: Record<string, unknown>, cwd = process.cwd()): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new ConfigValidationError(`Invalid environment configuration:\n  ${details.join('\n  ')}`);
  }
  const env = parsed.data;
  const dbPath = env.DB_PATH === ':memory:' ? ':memory:' : path.resolve(cwd, env.DB_PATH);
  const backupDir = env.BACKUP_DIR
    ? path.resolve(cwd, env.BACKUP_DIR)
    : dbPath === ':memory:'
      ? path.resolve(cwd, 'data/backups')
      : path.join(path.dirname(dbPath), 'backups');
  const rawTrustProxy = env.TRUST_PROXY ?? (env.NODE_ENV === 'production' ? '1' : '0');
  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    host: env.HOST,
    adminPassword: env.ADMIN_PASSWORD,
    sessionSecret: env.SESSION_SECRET,
    dbPath,
    backupDir,
    staticDir: path.resolve(cwd, env.STATIC_DIR),
    trustProxy: parseTrustProxy(rawTrustProxy),
    cookieSecure: env.COOKIE_SECURE,
    schedulerEnabled: env.SCHEDULER_ENABLED,
    schedulerIntervalMs: env.SCHEDULER_INTERVAL_MS,
    missedGraceMinutes: env.MISSED_GRACE_MINUTES,
    maxReminders: env.MAX_REMINDERS,
    deliveryRetentionDays: env.DELIVERY_RETENTION_DAYS,
    backupKeepDays: env.BACKUP_KEEP_DAYS,
    backupCron: env.BACKUP_CRON.trim(),
    allowPrivateUrls: env.ALLOW_PRIVATE_URLS,
    allowedPrivateHosts: env.ALLOWED_PRIVATE_HOSTS.split(',').map((item) => item.trim()).filter(Boolean),
    logLevel: env.LOG_LEVEL ?? (env.NODE_ENV === 'production' ? 'info' : env.NODE_ENV === 'test' ? 'silent' : 'debug'),
  };
}

/** Env files loaded by @nestjs/config (real environment variables always win). */
export function envFilePaths(nodeEnv = process.env.NODE_ENV): string[] {
  if (nodeEnv === 'test') return [];
  if (nodeEnv === 'production') return ['.env'];
  return ['.env.development.local', '.env.development'];
}
