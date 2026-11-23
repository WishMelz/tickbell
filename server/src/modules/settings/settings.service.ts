import * as crypto from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ValidationError } from '../../common/errors';
import { epochToLocalInput, isValidTimezone, localDateTimeToEpoch } from '../../common/time';
import { DatabaseService } from '../database/database.service';

export const SETTING_GLOBAL_TIMEZONE = 'global_timezone';
export const SETTING_SESSION_GENERATION = 'session_generation';
export const SETTING_AUTH_PASSWORD_HASH = 'auth_password_hash';
export const SETTING_AUTH_SESSION_SECRET = 'auth_session_secret';
export const SETTING_AUTO_BACKUP_CONFIG = 'auto_backup_config';
export const SETTING_AUTO_BACKUP_STATE = 'auto_backup_state';

/** Internal auth/session/backup-schedule keys excluded from business backup exports and preserved across restores. */
export const INTERNAL_SETTING_KEYS: ReadonlySet<string> = new Set([
  SETTING_SESSION_GENERATION,
  SETTING_AUTH_PASSWORD_HASH,
  SETTING_AUTH_SESSION_SECRET,
  SETTING_AUTO_BACKUP_CONFIG,
  SETTING_AUTO_BACKUP_STATE,
]);

interface InheritedReminderRow {
  id: string;
  starts_at: number;
  next_run_at: number;
}

@Injectable()
export class SettingsService {
  constructor(private readonly database: DatabaseService) {}

  getSetting(key: string): string | null {
    const row = this.database.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string, now = Date.now()): void {
    this.database.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, now);
  }

  getGlobalTimezone(): string {
    return this.getSetting(SETTING_GLOBAL_TIMEZONE) ?? 'UTC';
  }

  /**
   * Updates global timezone and preserves wall-clock time for all reminders inheriting it (`timezone IS NULL`),
   * all inside a single atomic SQLite transaction.
   */
  setGlobalTimezone(rawTimezone: unknown): string {
    if (typeof rawTimezone !== 'string' || !isValidTimezone(rawTimezone.trim())) {
      throw new ValidationError('全局时区无效');
    }
    const timezone = rawTimezone.trim();
    const now = Date.now();

    this.database.transaction(() => {
      const currentTimezone = this.getGlobalTimezone();
      if (currentTimezone === timezone) return;

      const inherited = this.database.db
        .prepare(
          `SELECT id, starts_at, next_run_at FROM reminders
           WHERE timezone IS NULL AND deleted_at IS NULL`,
        )
        .all() as InheritedReminderRow[];

      const updateStmt = this.database.db.prepare(
        `UPDATE reminders
         SET starts_at = ?, next_run_at = ?, schedule_version = schedule_version + 1, updated_at = ?
         WHERE id = ? AND timezone IS NULL AND deleted_at IS NULL`,
      );

      for (const reminder of inherited) {
        const startsAt = localDateTimeToEpoch(epochToLocalInput(reminder.starts_at, currentTimezone), timezone);
        const nextRunAt = localDateTimeToEpoch(epochToLocalInput(reminder.next_run_at, currentTimezone), timezone);
        updateStmt.run(startsAt, nextRunAt, now, reminder.id);
      }

      this.setSetting(SETTING_GLOBAL_TIMEZONE, timezone, now);
    });

    return timezone;
  }

  getSessionGeneration(): string {
    return this.getSetting(SETTING_SESSION_GENERATION) ?? '';
  }

  rotateSessionGeneration(now = Date.now()): string {
    const next = crypto.randomUUID();
    this.setSetting(SETTING_SESSION_GENERATION, next, now);
    return next;
  }

  getAuthPasswordHash(): string | null {
    const value = this.getSetting(SETTING_AUTH_PASSWORD_HASH);
    return value && value.length > 0 ? value : null;
  }

  setAuthPasswordHash(hash: string, now = Date.now()): void {
    this.setSetting(SETTING_AUTH_PASSWORD_HASH, hash, now);
  }

  getAuthSessionSecret(): string | null {
    const value = this.getSetting(SETTING_AUTH_SESSION_SECRET);
    return value && value.length > 0 ? value : null;
  }

  setAuthSessionSecret(secret: string, now = Date.now()): void {
    this.setSetting(SETTING_AUTH_SESSION_SECRET, secret, now);
  }
}
