import { calculateNextFutureRun } from '../common/repeat';
import { randomUuid } from '../crypto/index';
import type { CoreConfig, CoreLogger, DbAdapter, SqlStatement } from '../ports/index';
import type { DeliveriesRepository } from '../repositories/deliveries.repository';
import type { DueReminderRow, RemindersRepository } from '../repositories/reminders.repository';
import type { DeliveriesService } from './deliveries.service';
import { SETTING_LAST_CLEANUP_AT, type SettingsService } from './settings.service';

const PENDING_STALE_MS = 5 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

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

export interface TickSummary {
  claimedDeliveries: number;
  executedRetries: number;
  recoveredStalePending: number;
  deletedOldDeliveries: number;
  durationMs: number;
}

async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
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

/**
 * Unified reminder scheduler shared by Cloudflare Cron Triggers and Node.js interval polling.
 * Uses subrequest-budget-aware claiming so even hundreds of simultaneously due reminders
 * never exceed Cloudflare Workers Free Plan's 50-subrequest limit.
 */
export class CoreScheduler {
  private paused = false;
  private activeTick: Promise<TickSummary> | null = null;

  constructor(
    private readonly config: CoreConfig,
    private readonly db: DbAdapter,
    private readonly remindersRepo: RemindersRepository,
    private readonly deliveriesRepo: DeliveriesRepository,
    private readonly deliveriesService: DeliveriesService,
    private readonly settings: SettingsService,
    private readonly logger: CoreLogger,
  ) {}

  get isPaused(): boolean {
    return this.paused;
  }

  async pause(): Promise<void> {
    this.paused = true;
    if (this.activeTick) {
      await this.activeTick.catch(() => undefined);
    }
  }

  resume(): void {
    this.paused = false;
  }

  async failAllPendingOnBoot(now = Date.now()): Promise<number> {
    return this.deliveriesRepo.failAllPending('进程中断，发送状态未知', now);
  }

  async runTick(now = Date.now()): Promise<TickSummary> {
    if (this.paused || this.activeTick) {
      return {
        claimedDeliveries: 0,
        executedRetries: 0,
        recoveredStalePending: 0,
        deletedOldDeliveries: 0,
        durationMs: 0,
      };
    }
    const promise = this.executeTick(now);
    this.activeTick = promise;
    try {
      return await promise;
    } finally {
      if (this.activeTick === promise) {
        this.activeTick = null;
      }
    }
  }

  private async executeTick(now: number): Promise<TickSummary> {
    const startWall = Date.now();
    let claimedCount = 0;
    let retryCount = 0;
    let recoveredStalePending = 0;
    let deletedOldDeliveries = 0;

    try {
      // 1. Recover any stale pending deliveries older than 5 min (at-most-once safety across Worker timeouts / restarts)
      recoveredStalePending = await this.deliveriesRepo.failStalePendingBefore(
        now - PENDING_STALE_MS,
        '任务执行超时或中断，发送状态未知，已停止自动重发',
        now,
      );

      // 2. Fetch due reminders candidate pool (bounded to avoid scanning thousands of rows in a single tick)
      const dueCandidateLimit = Math.max(20, this.config.maxDeliveriesPerTick * 2);
      const due = await this.remindersRepo.findDue(now, dueCandidateLimit);
      const graceMs = this.config.missedGraceMinutes * 60 * 1000;
      const tasks: ClaimedDeliveryTask[] = [];

      if (due.length > 0) {
        const channelMap = await this.remindersRepo.getChannelIdsMap(due.map((r) => r.id));
        let remainingBudget = this.config.maxDeliveriesPerTick;

        for (const reminder of due) {
          const channelIds = channelMap.get(reminder.id) ?? [];
          const latenessMs = Math.max(0, now - reminder.next_run_at);
          const tooLate = latenessMs > graceMs;

          // Skipped reminders do not consume outbound HTTP subrequest budget.
          // For live reminders, if channels exceed remaining budget (and we already claimed at least one task),
          // leave this reminder for the next minute's Cron tick rather than exceeding CF subrequest limits.
          if (!tooLate && channelIds.length > remainingBudget && tasks.length > 0) {
            break;
          }

          try {
            const claimed = await this.claimAndAdvanceReminder(reminder, channelIds, now, graceMs);
            tasks.push(...claimed);
            remainingBudget -= claimed.length;
            if (remainingBudget <= 0) break;
          } catch (error) {
            this.logger.error(
              {
                err: error instanceof Error ? error.message : String(error),
                reminderId: reminder.id,
                scheduledAt: reminder.next_run_at,
              },
              'Failed to claim/advance due reminder',
            );
          }
        }
      }

      claimedCount = tasks.length;

      // 3. Deliver claimed tasks OUTSIDE DB transactions with bounded concurrency
      await runWithConcurrency(tasks, this.config.deliveryConcurrency, async (task) => {
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
          this.logger.error(
            { err: error instanceof Error ? error.message : String(error), deliveryId: task.deliveryId },
            'Unexpected delivery error',
          );
        }
      });

      // 4. Retry pass for due `retrying` rows (bounded by maxRetriesPerTick)
      const dueRetries = await this.deliveriesRepo.findDueRetries(now, this.config.maxRetriesPerTick);
      retryCount = dueRetries.length;
      await runWithConcurrency(dueRetries, this.config.deliveryConcurrency, async (row) => {
        try {
          await this.deliveriesService.executeScheduledRetry(row, now);
        } catch (error) {
          this.logger.error(
            { err: error instanceof Error ? error.message : String(error), deliveryId: row.id },
            'Unexpected retry error',
          );
        }
      });

      // 5. Opportunistic daily log retention cleanup (runs at most once per 24h without extra Cron triggers)
      const lastCleanupRaw = await this.settings.getSetting(SETTING_LAST_CLEANUP_AT);
      const lastCleanupAt = lastCleanupRaw ? Number.parseInt(lastCleanupRaw, 10) : 0;
      if (!Number.isFinite(lastCleanupAt) || now - lastCleanupAt >= CLEANUP_INTERVAL_MS) {
        const retentionCutoff = now - this.config.deliveryRetentionDays * 24 * 60 * 60 * 1000;
        deletedOldDeliveries = await this.deliveriesRepo.deleteOlderThan(retentionCutoff);
        await this.settings.setSetting(SETTING_LAST_CLEANUP_AT, String(now), now);
      }

      const endWall = Date.now();
      const durationMs = endWall - startWall;
      await this.settings.saveCronHeartbeat({ lastTickAt: endWall, lastTickDurationMs: durationMs }, endWall);

      return {
        claimedDeliveries: claimedCount,
        executedRetries: retryCount,
        recoveredStalePending,
        deletedOldDeliveries,
        durationMs,
      };
    } catch (error) {
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'Scheduler tick failed',
      );
      return {
        claimedDeliveries: claimedCount,
        executedRetries: retryCount,
        recoveredStalePending,
        deletedOldDeliveries,
        durationMs: Date.now() - startWall,
      };
    }
  }

  /**
   * Atomically advances the reminder AND claims deliveries (or records `skipped`) in a single `db.batch()`.
   */
  private async claimAndAdvanceReminder(
    reminder: DueReminderRow,
    channelIds: readonly string[],
    now: number,
    graceMs: number,
  ): Promise<ClaimedDeliveryTask[]> {
    const latenessMs = Math.max(0, now - reminder.next_run_at);
    const tooLate = latenessMs > graceMs;
    const isLate = latenessMs > 60_000;
    const timezone = reminder.effective_timezone;
    const expectedVersionAfterAdvance = reminder.schedule_version + 1;

    const advanceStmt: SqlStatement =
      reminder.is_repeating === 0 || !reminder.repeat_every || !reminder.repeat_unit
        ? this.remindersRepo.advanceSingleToCompletedStatement(
            reminder.id,
            reminder.next_run_at,
            reminder.schedule_version,
            now,
          )
        : this.remindersRepo.advanceRepeatingStatement(
            reminder.id,
            reminder.next_run_at,
            reminder.schedule_version,
            calculateNextFutureRun(reminder.next_run_at, now, {
              every: reminder.repeat_every,
              unit: reminder.repeat_unit,
              timezone,
              startsAt: reminder.starts_at,
            }),
            now,
          );

    const stmts: SqlStatement[] = [advanceStmt];
    const planned: Array<{
      stmtIndex: number;
      deliveryId: string;
      eventId: string;
      channelId: string;
      skipped: boolean;
    }> = [];

    for (const channelId of channelIds) {
      const deliveryId = randomUuid();
      const eventId = randomUuid();
      const [insertStmt, receiptStmt] = this.deliveriesRepo.claimStatements({
        id: deliveryId,
        eventId,
        reminderId: reminder.id,
        expectedVersionAfterAdvance,
        scheduledAt: reminder.next_run_at,
        channelId,
        status: tooLate ? 'skipped' : 'pending',
        error: tooLate ? `超出错过提醒宽限窗口（${this.config.missedGraceMinutes} 分钟），已跳过` : null,
        now,
      });
      planned.push({
        stmtIndex: stmts.length,
        deliveryId,
        eventId,
        channelId,
        skipped: tooLate,
      });
      stmts.push(insertStmt, receiptStmt);
    }

    const results = await this.db.batch(stmts);
    if ((results[0]?.changes ?? 0) === 0) {
      return [];
    }

    const tasks: ClaimedDeliveryTask[] = [];
    for (const item of planned) {
      if (!item.skipped && (results[item.stmtIndex]?.changes ?? 0) > 0) {
        tasks.push({
          deliveryId: item.deliveryId,
          eventId: item.eventId,
          reminderId: reminder.id,
          title: reminder.title,
          content: reminder.content,
          contentHtml: reminder.content_html,
          timezone,
          scheduledAt: reminder.next_run_at,
          channelId: item.channelId,
          isLate,
        });
      }
    }
    return tasks;
  }
}
