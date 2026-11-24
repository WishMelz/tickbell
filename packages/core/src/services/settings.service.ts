import { ValidationError } from '../common/errors';
import { epochToLocalInput, isValidTimezone, localDateTimeToEpoch } from '../common/time';
import { randomUuid } from '../crypto/index';
import type { DbAdapter, SqlStatement } from '../ports/index';
import type { RemindersRepository } from '../repositories/reminders.repository';
import type { SettingsRepository } from '../repositories/settings.repository';

export const SETTING_GLOBAL_TIMEZONE = 'global_timezone';
export const SETTING_SESSION_GENERATION = 'session_generation';
export const SETTING_AUTH_PASSWORD_HASH = 'auth_password_hash';
export const SETTING_AUTH_SESSION_SECRET = 'auth_session_secret';
export const SETTING_AUTO_BACKUP_CONFIG = 'auto_backup_config';
export const SETTING_AUTO_BACKUP_STATE = 'auto_backup_state';
export const SETTING_CRON_HEARTBEAT = 'cron_heartbeat';
export const SETTING_LAST_CLEANUP_AT = 'last_cleanup_at';

/** Internal auth/session/scheduler/backup-schedule keys excluded from business backup exports and preserved across restores. */
export const INTERNAL_SETTING_KEYS: ReadonlySet<string> = new Set([
  SETTING_SESSION_GENERATION,
  SETTING_AUTH_PASSWORD_HASH,
  SETTING_AUTH_SESSION_SECRET,
  SETTING_AUTO_BACKUP_CONFIG,
  SETTING_AUTO_BACKUP_STATE,
  SETTING_CRON_HEARTBEAT,
  SETTING_LAST_CLEANUP_AT,
]);

export interface CronHeartbeat {
  lastTickAt: number;
  lastTickDurationMs: number;
}

export class SettingsService {
  constructor(
    private readonly db: DbAdapter,
    private readonly repo: SettingsRepository,
    private readonly remindersRepo: RemindersRepository,
  ) {}

  async getSetting(key: string): Promise<string | null> {
    return this.repo.get(key);
  }

  async setSetting(key: string, value: string, now = Date.now()): Promise<void> {
    await this.repo.set(key, value, now);
  }

  async getGlobalTimezone(): Promise<string> {
    return (await this.repo.get(SETTING_GLOBAL_TIMEZONE)) ?? 'UTC';
  }

  /**
   * Updates global timezone and preserves wall-clock time for all reminders inheriting it (`timezone IS NULL`),
   * atomically inside a single `db.batch()` with `schedule_version` optimistic check.
   */
  async setGlobalTimezone(rawTimezone: unknown): Promise<string> {
    if (typeof rawTimezone !== 'string' || !isValidTimezone(rawTimezone.trim())) {
      throw new ValidationError('全局时区无效');
    }
    const timezone = rawTimezone.trim();
    const now = Date.now();

    const currentTimezone = await this.getGlobalTimezone();
    if (currentTimezone === timezone) return timezone;

    const inherited = await this.remindersRepo.findInheritedGlobalTimezone();
    const stmts: SqlStatement[] = [];

    for (const reminder of inherited) {
      const startsAt = localDateTimeToEpoch(epochToLocalInput(reminder.starts_at, currentTimezone), timezone);
      const nextRunAt = localDateTimeToEpoch(epochToLocalInput(reminder.next_run_at, currentTimezone), timezone);
      stmts.push({
        sql: `UPDATE reminders
              SET starts_at = ?, next_run_at = ?, schedule_version = schedule_version + 1, updated_at = ?
              WHERE id = ? AND timezone IS NULL AND deleted_at IS NULL`,
        params: [startsAt, nextRunAt, now, reminder.id],
      });
    }

    stmts.push(this.repo.upsertStatement(SETTING_GLOBAL_TIMEZONE, timezone, now));
    await this.db.batch(stmts);

    return timezone;
  }

  async getSessionGeneration(): Promise<string> {
    return (await this.repo.get(SETTING_SESSION_GENERATION)) ?? '';
  }

  async rotateSessionGeneration(now = Date.now()): Promise<string> {
    const next = randomUuid();
    await this.repo.set(SETTING_SESSION_GENERATION, next, now);
    return next;
  }

  async getAuthPasswordHash(): Promise<string | null> {
    const value = await this.repo.get(SETTING_AUTH_PASSWORD_HASH);
    return value && value.length > 0 ? value : null;
  }

  async getAuthSessionSecret(): Promise<string | null> {
    const value = await this.repo.get(SETTING_AUTH_SESSION_SECRET);
    return value && value.length > 0 ? value : null;
  }

  async getCronHeartbeat(): Promise<CronHeartbeat | null> {
    const raw = await this.repo.get(SETTING_CRON_HEARTBEAT);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<CronHeartbeat>;
      if (typeof parsed.lastTickAt === 'number' && typeof parsed.lastTickDurationMs === 'number') {
        return { lastTickAt: parsed.lastTickAt, lastTickDurationMs: parsed.lastTickDurationMs };
      }
    } catch {
      // ignore invalid JSON
    }
    return null;
  }

  async saveCronHeartbeat(heartbeat: CronHeartbeat, now = Date.now()): Promise<void> {
    await this.repo.set(SETTING_CRON_HEARTBEAT, JSON.stringify(heartbeat), now);
  }
}
