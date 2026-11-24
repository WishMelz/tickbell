import * as fs from 'node:fs';
import * as path from 'node:path';
import { getConnInfo } from '@hono/node-server/conninfo';
import {
  consoleLogger,
  createCoreApp,
  epochToIso,
  silentLogger,
  type ChannelProvider,
  type CoreAppBundle,
  type CoreConfig,
  type CoreLogger,
  type DemoPolicy,
  type HttpTransport,
  type RuntimeStatusMeta,
} from '@tickbell/core';
import { CronJob } from 'cron';
import type { NodeAppConfig } from './config';
import { ensureDemoAuthInitialized, isDemoDatabaseEmpty, resetDemoData } from './demo-seed';
import { LocalDiskBackupStorage } from './disk-backup';
import { MemoryRateLimiter } from './memory-ratelimit';
import { createNodeHttpTransport } from './node-transport';
import { SqliteDbAdapter } from './sqlite-adapter';
import { createStaticSpaHandler } from './static-files';

const APP_VERSION = '2.0.0';
const AUTO_BACKUP_CHECK_MS = 30_000;

export interface NodeRuntimeHandle {
  bundle: CoreAppBundle;
  db: SqliteDbAdapter;
  startBackgroundTasks: () => Promise<void>;
  runSqliteBackup: (now?: number) => Promise<string | null>;
  resetDemoData: (now?: number) => Promise<void>;
  shutdown: () => Promise<void>;
}

export interface CreateNodeRuntimeOptions {
  config: NodeAppConfig;
  http?: HttpTransport;
  extraProviders?: readonly ChannelProvider[];
  logger?: CoreLogger;
}

export function createNodeRuntime(options: CreateNodeRuntimeOptions): NodeRuntimeHandle {
  const { config } = options;
  const logger = options.logger ?? (config.nodeEnv === 'test' ? silentLogger : consoleLogger);
  const startedAt = Date.now();

  const db = new SqliteDbAdapter(config.dbPath, config.migrationsDir, logger);
  db.open();

  let lastBackupAt: number | null = null;
  let lastBackupFile: string | null = null;
  let reminderTimer: ReturnType<typeof setInterval> | null = null;
  let autoBackupTimer: ReturnType<typeof setInterval> | null = null;
  let dailyBackupCron: CronJob | null = null;
  let demoResetCron: CronJob | null = null;

  const scanLatestBackup = () => {
    if (config.dbPath === ':memory:' || !fs.existsSync(config.backupDir)) return;
    try {
      const files = fs
        .readdirSync(config.backupDir)
        .filter((name) => name.startsWith('tickbell-') && name.endsWith('.db'))
        .map((name) => ({ name, mtime: fs.statSync(path.join(config.backupDir, name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (files[0]) {
        lastBackupFile = files[0].name;
        lastBackupAt = Math.floor(files[0].mtime);
      }
    } catch {
      // ignore
    }
  };

  const pruneOldDbBackups = (now: number) => {
    if (!fs.existsSync(config.backupDir)) return;
    const cutoff = now - config.backupKeepDays * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(config.backupDir)) {
      if (!name.startsWith('tickbell-') || !name.endsWith('.db')) continue;
      const fullPath = path.join(config.backupDir, name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile() && stat.mtimeMs < cutoff) fs.unlinkSync(fullPath);
      } catch {
        // ignore
      }
    }
  };

  const runSqliteBackup = async (now = Date.now()): Promise<string | null> => {
    if (config.dbPath === ':memory:') return null;
    try {
      const d = new Date(now);
      const pad = (n: number) => String(n).padStart(2, '0');
      const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
      const fileName = `tickbell-${stamp}.db`;
      const target = path.join(config.backupDir, fileName);
      db.vacuumInto(target);
      lastBackupAt = now;
      lastBackupFile = fileName;
      pruneOldDbBackups(now);
      db.optimize();
      logger.info({ backupFile: fileName }, 'Completed SQLite online backup');
      return fileName;
    } catch (error) {
      logger.error({ err: error instanceof Error ? error.message : String(error) }, 'SQLite online backup failed');
      return null;
    }
  };

  scanLatestBackup();

  const demoPolicy: DemoPolicy | undefined = config.demoMode
    ? {
        enabled: true,
        passwordHint: config.demoPassword,
        maxReminders: config.demoMaxReminders,
        maxChannels: config.demoMaxChannels,
        maxTestChannels: config.demoMaxTestChannels,
        resetScheduleLabel: `每日 03:00（${config.demoResetTimezone}）`,
      }
    : undefined;

  const coreConfig: CoreConfig = {
    version: APP_VERSION,
    runtime: 'node',
    demo: demoPolicy,
    adminPassword: config.adminPassword,
    sessionSecret: config.sessionSecret,
    cookieSecure: config.cookieSecure,
    missedGraceMinutes: config.missedGraceMinutes,
    deliveryRetentionDays: config.deliveryRetentionDays,
    allowPrivateUrls: config.allowPrivateUrls,
    allowedPrivateHosts: config.allowedPrivateHosts,
    maxDeliveriesPerTick: 200,
    maxRetriesPerTick: 100,
    deliveryConcurrency: 5,
    healthHeartbeatMaxAgeMs: Math.max(120_000, config.schedulerIntervalMs * 4),
  };

  const getRuntimeMeta = (): RuntimeStatusMeta => ({
    version: APP_VERSION,
    runtime: 'node',
    runtimeLabel: config.demoMode ? `演示模式 · Node ${process.version} + SQLite` : `Node ${process.version} + SQLite`,
    startedAt: epochToIso(startedAt),
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    capabilities: {
      proxies: !config.demoMode,
      diskAutoBackup: !config.demoMode,
      sqliteVacuumBackup: !config.demoMode,
      minScheduleIntervalSec: Math.max(1, Math.round(config.schedulerIntervalMs / 1000)),
      allowPrivateUrls: config.allowPrivateUrls,
    },
    demo: demoPolicy,
    schedulerEnabled: config.schedulerEnabled,
    schedulerPaused: false,
    schedulerIntervalMs: config.schedulerIntervalMs,
    sqliteBackup: {
      lastBackupAt: lastBackupAt ? epochToIso(lastBackupAt) : null,
      lastBackupFile,
      keepDays: config.demoMode ? 0 : config.backupKeepDays,
    },
  });

  const staticSpaHandler = createStaticSpaHandler(config.staticDir);

  const bundle = createCoreApp({
    config: coreConfig,
    db,
    http: options.http ?? createNodeHttpTransport(),
    rateLimiter: new MemoryRateLimiter(5, 60_000),
    testRateLimiter: new MemoryRateLimiter(config.demoTestRateLimit, 60_000),
    getRuntimeMeta,
    autoBackupStorage: config.demoMode ? undefined : new LocalDiskBackupStorage(config.backupDir),
    extraProviders: options.extraProviders,
    logger,
    trustForwardedProto: config.trustProxy,
    getClientIp: (c) => {
      if (config.trustProxy) {
        const xff = c.req.header('X-Forwarded-For');
        if (xff) return xff;
      }
      try {
        return getConnInfo(c).remote.address;
      } catch {
        return undefined;
      }
    },
    fallbackHandler: (c) => staticSpaHandler(c.req.raw),
  });

  const runDemoReset = async (now = Date.now()): Promise<void> => {
    try {
      await ensureDemoAuthInitialized(db, config.demoPassword, config.sessionSecret, now);
      await resetDemoData(db, now);
      logger.info({ timezone: config.demoResetTimezone }, 'Demo database reset to curated seed data');
    } catch (error) {
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to reset demo database',
      );
    }
  };

  const startBackgroundTasks = async () => {
    if (config.demoMode) {
      await ensureDemoAuthInitialized(db, config.demoPassword, config.sessionSecret);
      if (await isDemoDatabaseEmpty(db)) {
        await resetDemoData(db);
        logger.info({}, 'Seeded initial demo data on startup');
      }
      try {
        demoResetCron = CronJob.from({
          cronTime: config.demoResetCron,
          onTick: () => {
            void runDemoReset();
          },
          start: true,
          timeZone: config.demoResetTimezone,
        });
        logger.info(
          { cron: config.demoResetCron, timeZone: config.demoResetTimezone },
          'Demo mode active: reminder scheduler disabled, daily data reset cron registered',
        );
      } catch (error) {
        logger.error(
          { err: error instanceof Error ? error.message : String(error), cron: config.demoResetCron },
          'Failed to register daily demo reset cron',
        );
      }
      return;
    }

    const staleCount = await bundle.scheduler.failAllPendingOnBoot(Date.now());
    if (staleCount > 0) {
      logger.warn({ staleCount }, 'Marked leftover pending deliveries as failed on startup');
    }
    if (!config.schedulerEnabled) {
      logger.info({}, 'Scheduler disabled via SCHEDULER_ENABLED=false');
      return;
    }

    reminderTimer = setInterval(() => {
      void bundle.scheduler.runTick();
    }, config.schedulerIntervalMs);

    autoBackupTimer = setInterval(() => {
      void bundle.backup.runAutoBackupIfDue();
    }, AUTO_BACKUP_CHECK_MS);

    try {
      dailyBackupCron = CronJob.from({
        cronTime: config.backupCron,
        onTick: () => {
          void runSqliteBackup();
        },
        start: true,
        timeZone: 'UTC',
      });
    } catch (error) {
      logger.error(
        { err: error instanceof Error ? error.message : String(error), cron: config.backupCron },
        'Failed to register daily SQLite backup cron',
      );
    }

    // Immediate non-blocking startup catch-up
    void bundle.scheduler.runTick();
    void bundle.backup.runAutoBackupIfDue();
  };

  const shutdown = async () => {
    if (reminderTimer) clearInterval(reminderTimer);
    if (autoBackupTimer) clearInterval(autoBackupTimer);
    if (dailyBackupCron) dailyBackupCron.stop();
    if (demoResetCron) demoResetCron.stop();
    await bundle.scheduler.pause();
    db.close();
  };

  return { bundle, db, startBackgroundTasks, runSqliteBackup, resetDemoData: runDemoReset, shutdown };
}
