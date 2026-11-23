import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { calculateNextFutureRun } from '../../common/repeat';
import { epochToIso } from '../../common/time';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { DatabaseService } from '../database/database.service';
import { DeliveriesRepository } from '../deliveries/deliveries.repository';
import { DeliveriesService } from '../deliveries/deliveries.service';
import { type DueReminderRow, RemindersRepository } from '../reminders/reminders.repository';

const INTERVAL_NAME = 'tickbell-reminder-tick';
const BACKUP_CRON_NAME = 'tickbell-daily-maintenance';
const DELIVERY_CONCURRENCY = 5;
const SHUTDOWN_WAIT_MS = 20_000;

interface ClaimedDeliveryTask {
  deliveryId: string;
  eventId: string;
  reminderId: string;
  title: string;
  content: string;
  contentHtml: string | null;
  timezone: string;
  scheduledAt: number;
  channelId: string;
  isLate: boolean;
}

export interface SchedulerStatus {
  enabled: boolean;
  paused: boolean;
  intervalMs: number;
  lastTickAt: string | null;
  lastTickDurationMs: number | null;
}

export interface BackupStatus {
  lastBackupAt: string | null;
  lastBackupFile: string | null;
  keepDays: number;
}

async function runWithConcurrency<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  if (!items.length) return;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await worker(items[idx]!);
    }
  });
  await Promise.all(workers);
}

@Injectable()
export class SchedulerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly startedAt = Date.now();
  private paused = false;
  private activeTick: Promise<void> | null = null;
  private lastTickAt: number | null = null;
  private lastTickDurationMs: number | null = null;
  private lastBackupAt: number | null = null;
  private lastBackupFile: string | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly registry: SchedulerRegistry,
    private readonly database: DatabaseService,
    private readonly remindersRepo: RemindersRepository,
    private readonly deliveriesRepo: DeliveriesRepository,
    private readonly deliveriesService: DeliveriesService,
  ) {}

  onApplicationBootstrap(): void {
    // 1. Fail any leftover `pending` deliveries from an interrupted process (at-most-once safety)
    const staleCount = this.deliveriesRepo.failAllStalePending('进程中断，发送状态未知', Date.now());
    if (staleCount > 0) {
      this.logger.warn({ staleCount }, 'Marked leftover pending deliveries as failed on startup');
    }

    // 2. Discover latest backup file on disk (if any)
    this.scanLatestBackup();

    if (!this.config.schedulerEnabled) {
      this.logger.log('Scheduler is disabled via SCHEDULER_ENABLED=false');
      return;
    }

    // 3. Register polling interval
    const timer = setInterval(() => {
      void this.runTick();
    }, this.config.schedulerIntervalMs);
    this.registry.addInterval(INTERVAL_NAME, timer);

    // 4. Register daily backup + log retention cron
    try {
      const job = CronJob.from({
        cronTime: this.config.backupCron,
        onTick: () => {
          void this.runDailyMaintenance();
        },
        start: true,
        timeZone: 'UTC',
      });
      this.registry.addCronJob(BACKUP_CRON_NAME, job);
    } catch (error) {
      this.logger.error({ err: error, cron: this.config.backupCron }, 'Failed to register daily maintenance cron');
    }

    // 5. Immediate startup catch-up tick (non-blocking)
    void this.runTick();
  }

  async onApplicationShutdown(): Promise<void> {
    this.paused = true;
    try {
      if (this.registry.doesExist('interval', INTERVAL_NAME)) {
        this.registry.deleteInterval(INTERVAL_NAME);
      }
    } catch {
      // ignore
    }
    try {
      if (this.registry.doesExist('cron', BACKUP_CRON_NAME)) {
        this.registry.deleteCronJob(BACKUP_CRON_NAME);
      }
    } catch {
      // ignore
    }

    if (this.activeTick) {
      this.logger.log('Waiting for in-flight reminder deliveries before shutdown...');
      await Promise.race([
        this.activeTick.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_WAIT_MS)),
      ]);
    }
  }

  /** Pauses future ticks and waits for any currently executing tick to finish. */
  async pause(): Promise<void> {
    this.paused = true;
    if (this.activeTick) {
      await this.activeTick.catch(() => undefined);
    }
  }

  resume(): void {
    this.paused = false;
  }

  /**
   * Executes one scheduler pass (due reminders + due retries).
   * Single-flight guarded: overlapping calls return immediately.
   * Exposed publicly so tests can drive ticks deterministically with a custom clock.
   */
  async runTick(now = Date.now()): Promise<void> {
    if (this.paused || this.activeTick) return;
    const promise = this.executeTick(now);
    this.activeTick = promise;
    try {
      await promise;
    } finally {
      if (this.activeTick === promise) {
        this.activeTick = null;
      }
    }
  }

  private async executeTick(now: number): Promise<void> {
    const startWall = Date.now();
    try {
      const due = this.remindersRepo.findDue(now, 200);
      const graceMs = this.config.missedGraceMinutes * 60 * 1000;
      const tasks: ClaimedDeliveryTask[] = [];

      for (const reminder of due) {
        try {
          const claimed = this.claimAndAdvanceReminder(reminder, now, graceMs);
          tasks.push(...claimed);
        } catch (error) {
          this.logger.error(
            { err: error, reminderId: reminder.id, scheduledAt: reminder.next_run_at },
            'Failed to claim/advance due reminder',
          );
        }
      }

      // Send claimed notifications OUTSIDE DB transactions with bounded concurrency
      await runWithConcurrency(tasks, DELIVERY_CONCURRENCY, async (task) => {
        try {
          await this.deliveriesService.executeDelivery({
            deliveryId: task.deliveryId,
            eventId: task.eventId,
            reminderId: task.reminderId,
            title: task.title,
            content: task.content,
            contentHtml: task.contentHtml,
            timezone: task.timezone,
            scheduledAt: task.scheduledAt,
            channelId: task.channelId,
            previousAttempts: 0,
            isLate: task.isLate,
            allowAutoRetry: true,
            now,
          });
        } catch (error) {
          this.logger.error({ err: error, deliveryId: task.deliveryId }, 'Unexpected delivery error');
        }
      });

      // Retry pass for due `retrying` rows
      const dueRetries = this.deliveriesRepo.findDueRetries(now, 100);
      await runWithConcurrency(dueRetries, DELIVERY_CONCURRENCY, async (row) => {
        try {
          await this.deliveriesService.executeScheduledRetry(row, now);
        } catch (error) {
          this.logger.error({ err: error, deliveryId: row.id }, 'Unexpected retry error');
        }
      });

      this.lastTickAt = Date.now();
      this.lastTickDurationMs = this.lastTickAt - startWall;
    } catch (error) {
      this.logger.error({ err: error }, 'Scheduler tick failed');
    }
  }

  /**
   * Atomically claims deliveries (or records `skipped` if outside grace window) AND advances the reminder's schedule.
   */
  private claimAndAdvanceReminder(
    reminder: DueReminderRow,
    now: number,
    graceMs: number,
  ): ClaimedDeliveryTask[] {
    return this.database.transaction(() => {
      const channelIds = this.remindersRepo.getChannelIds(reminder.id);
      const latenessMs = Math.max(0, now - reminder.next_run_at);
      const tooLate = latenessMs > graceMs;
      const isLate = latenessMs > 60_000;
      const timezone = reminder.effective_timezone;

      // Optimistically advance reminder first; if it was edited concurrently, skip claiming.
      const advanced = this.advanceReminderInTx(reminder, timezone, now);
      if (!advanced) return [];

      const claimedTasks: ClaimedDeliveryTask[] = [];
      for (const channelId of channelIds) {
        const deliveryId = crypto.randomUUID();
        const eventId = crypto.randomUUID();
        if (tooLate) {
          this.deliveriesRepo.claim({
            id: deliveryId,
            eventId,
            reminderId: reminder.id,
            scheduledAt: reminder.next_run_at,
            channelId,
            status: 'skipped',
            error: `超出错过提醒宽限窗口（${this.config.missedGraceMinutes} 分钟），已跳过`,
            now,
          });
        } else {
          const inserted = this.deliveriesRepo.claim({
            id: deliveryId,
            eventId,
            reminderId: reminder.id,
            scheduledAt: reminder.next_run_at,
            channelId,
            status: 'pending',
            now,
          });
          if (inserted) {
            claimedTasks.push({
              deliveryId,
              eventId,
              reminderId: reminder.id,
              title: reminder.title,
              content: reminder.content,
              contentHtml: reminder.content_html,
              timezone,
              scheduledAt: reminder.next_run_at,
              channelId,
              isLate,
            });
          }
        }
      }
      return claimedTasks;
    });
  }

  private advanceReminderInTx(reminder: DueReminderRow, timezone: string, now: number): boolean {
    if (reminder.is_repeating === 0 || !reminder.repeat_every || !reminder.repeat_unit) {
      return this.remindersRepo.advanceSingleToCompleted(
        reminder.id,
        reminder.next_run_at,
        reminder.schedule_version,
        now,
      );
    }

    const nextRunAt = calculateNextFutureRun(reminder.next_run_at, now, {
      every: reminder.repeat_every,
      unit: reminder.repeat_unit,
      timezone,
      startsAt: reminder.starts_at,
    });
    return this.remindersRepo.advanceRepeating(
      reminder.id,
      reminder.next_run_at,
      reminder.schedule_version,
      nextRunAt,
      now,
    );
  }

  /** Performs daily online SQLite backup (`VACUUM INTO`), old backup pruning, delivery log cleanup, and `PRAGMA optimize`. */
  async runDailyMaintenance(now = Date.now()): Promise<{ backupFile: string | null; deletedDeliveries: number }> {
    let backupFile: string | null = null;
    if (this.config.dbPath !== ':memory:') {
      try {
        const d = new Date(now);
        const pad = (n: number) => String(n).padStart(2, '0');
        const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
        const fileName = `tickbell-${stamp}.db`;
        const target = path.join(this.config.backupDir, fileName);
        this.database.vacuumInto(target);
        this.lastBackupAt = now;
        this.lastBackupFile = fileName;
        backupFile = fileName;
        this.pruneOldBackups(now);
        this.logger.log({ backupFile }, 'Completed SQLite online backup');
      } catch (error) {
        this.logger.error({ err: error }, 'SQLite online backup failed');
      }
    }

    const retentionCutoff = now - this.config.deliveryRetentionDays * 24 * 60 * 60 * 1000;
    const deletedDeliveries = this.deliveriesRepo.deleteOlderThan(retentionCutoff);
    this.database.optimize();
    if (deletedDeliveries > 0) {
      this.logger.log({ deletedDeliveries }, 'Pruned expired delivery logs');
    }
    return { backupFile, deletedDeliveries };
  }

  private pruneOldBackups(now: number): void {
    if (!fs.existsSync(this.config.backupDir)) return;
    const cutoff = now - this.config.backupKeepDays * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(this.config.backupDir)) {
      if ((!name.startsWith('tickbell-') && !name.startsWith('tips-')) || !name.endsWith('.db')) continue;
      const fullPath = path.join(this.config.backupDir, name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          fs.unlinkSync(fullPath);
        }
      } catch {
        // ignore individual unlink errors
      }
    }
  }

  private scanLatestBackup(): void {
    if (this.config.dbPath === ':memory:' || !fs.existsSync(this.config.backupDir)) return;
    try {
      const files = fs
        .readdirSync(this.config.backupDir)
        .filter((name) => (name.startsWith('tickbell-') || name.startsWith('tips-')) && name.endsWith('.db'))
        .map((name) => ({ name, mtime: fs.statSync(path.join(this.config.backupDir, name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (files[0]) {
        this.lastBackupFile = files[0].name;
        this.lastBackupAt = Math.floor(files[0].mtime);
      }
    } catch {
      // ignore
    }
  }

  getHealth(): { enabled: boolean; lastTickAt: string | null; healthy: boolean } {
    if (!this.config.schedulerEnabled) {
      return { enabled: false, lastTickAt: null, healthy: true };
    }
    const now = Date.now();
    const threshold = Math.max(120_000, this.config.schedulerIntervalMs * 4);
    const healthy =
      this.lastTickAt !== null
        ? now - this.lastTickAt <= threshold
        : now - this.startedAt <= threshold;
    return {
      enabled: true,
      lastTickAt: this.lastTickAt ? epochToIso(this.lastTickAt) : null,
      healthy,
    };
  }

  getStatus(): SchedulerStatus {
    return {
      enabled: this.config.schedulerEnabled,
      paused: this.paused,
      intervalMs: this.config.schedulerIntervalMs,
      lastTickAt: this.lastTickAt ? epochToIso(this.lastTickAt) : null,
      lastTickDurationMs: this.lastTickDurationMs,
    };
  }

  getBackupStatus(): BackupStatus {
    return {
      lastBackupAt: this.lastBackupAt ? epochToIso(this.lastBackupAt) : null,
      lastBackupFile: this.lastBackupFile,
      keepDays: this.config.backupKeepDays,
    };
  }
}
