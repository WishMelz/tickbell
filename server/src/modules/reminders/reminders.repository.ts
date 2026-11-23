import { Injectable } from '@nestjs/common';
import type { RepeatUnit } from '../../common/repeat';
import { DatabaseService } from '../database/database.service';

export interface ReminderRow {
  id: string;
  title: string;
  content: string;
  content_html: string | null;
  category: string;
  tags: string;
  timezone: string | null;
  starts_at: number;
  is_repeating: number;
  repeat_every: number | null;
  repeat_unit: RepeatUnit | null;
  enabled: number;
  completed: number;
  next_run_at: number;
  schedule_version: number;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface DueReminderRow extends ReminderRow {
  effective_timezone: string;
}

export type ReminderStatusFilter = 'active' | 'paused' | 'completed';

export interface ReminderListFilters {
  search?: string;
  category?: string;
  tag?: string;
  status?: ReminderStatusFilter;
}

@Injectable()
export class RemindersRepository {
  constructor(private readonly database: DatabaseService) {}

  findAll(filters: ReminderListFilters, limit: number): ReminderRow[] {
    const conditions: string[] = ['deleted_at IS NULL'];
    const bindings: unknown[] = [];

    if (filters.search) {
      conditions.push(`(
        title LIKE ? OR content LIKE ? OR category LIKE ?
        OR EXISTS (SELECT 1 FROM json_each(reminders.tags) WHERE value LIKE ?)
      )`);
      const pattern = `%${filters.search}%`;
      bindings.push(pattern, pattern, pattern, pattern);
    }
    if (filters.category) {
      conditions.push('category = ?');
      bindings.push(filters.category);
    }
    if (filters.tag) {
      conditions.push('EXISTS (SELECT 1 FROM json_each(reminders.tags) WHERE value = ?)');
      bindings.push(filters.tag);
    }
    if (filters.status === 'active') {
      conditions.push('enabled = 1 AND completed = 0');
    } else if (filters.status === 'paused') {
      conditions.push('enabled = 0 AND completed = 0');
    } else if (filters.status === 'completed') {
      conditions.push('completed = 1');
    }

    bindings.push(limit);
    return this.database.db
      .prepare(
        `SELECT * FROM reminders
         WHERE ${conditions.join(' AND ')}
         ORDER BY next_run_at ASC
         LIMIT ?`,
      )
      .all(...bindings) as ReminderRow[];
  }

  findById(id: string, includeDeleted = false): ReminderRow | null {
    const sql = includeDeleted
      ? 'SELECT * FROM reminders WHERE id = ?'
      : 'SELECT * FROM reminders WHERE id = ? AND deleted_at IS NULL';
    const row = this.database.db.prepare(sql).get(id) as ReminderRow | undefined;
    return row ?? null;
  }

  findByIds(ids: string[]): ReminderRow[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.database.db
      .prepare(`SELECT * FROM reminders WHERE id IN (${placeholders}) AND deleted_at IS NULL`)
      .all(...ids) as ReminderRow[];
  }

  countActive(): number {
    const row = this.database.db
      .prepare('SELECT COUNT(*) AS count FROM reminders WHERE deleted_at IS NULL')
      .get() as { count: number };
    return row.count;
  }

  countEnabledActive(): number {
    const row = this.database.db
      .prepare('SELECT COUNT(*) AS count FROM reminders WHERE deleted_at IS NULL AND enabled = 1 AND completed = 0')
      .get() as { count: number };
    return row.count;
  }

  getChannelIdsMap(reminderIds: string[]): Map<string, string[]> {
    const map = new Map<string, string[]>();
    if (!reminderIds.length) return map;
    const placeholders = reminderIds.map(() => '?').join(',');
    const rows = this.database.db
      .prepare(
        `SELECT reminder_id, channel_id FROM reminder_channels
         WHERE reminder_id IN (${placeholders})
         ORDER BY channel_id`,
      )
      .all(...reminderIds) as Array<{ reminder_id: string; channel_id: string }>;
    for (const row of rows) {
      const list = map.get(row.reminder_id);
      if (list) list.push(row.channel_id);
      else map.set(row.reminder_id, [row.channel_id]);
    }
    return map;
  }

  getChannelIds(reminderId: string): string[] {
    const rows = this.database.db
      .prepare('SELECT channel_id FROM reminder_channels WHERE reminder_id = ? ORDER BY channel_id')
      .all(reminderId) as Array<{ channel_id: string }>;
    return rows.map((row) => row.channel_id);
  }

  findDue(now: number, limit = 200): DueReminderRow[] {
    return this.database.db
      .prepare(
        `SELECT reminders.*, COALESCE(timezone,
           (SELECT value FROM settings WHERE key = 'global_timezone'), 'UTC') AS effective_timezone
         FROM reminders
         WHERE enabled = 1 AND completed = 0 AND deleted_at IS NULL AND next_run_at <= ?
         ORDER BY next_run_at ASC
         LIMIT ?`,
      )
      .all(now, limit) as DueReminderRow[];
  }

  insert(row: Omit<ReminderRow, 'deleted_at' | 'schedule_version'>, channelIds: string[]): void {
    this.database.db
      .prepare(
        `INSERT INTO reminders (
           id, title, content, content_html, category, tags, timezone,
           starts_at, is_repeating, repeat_every, repeat_unit,
           enabled, completed, next_run_at, schedule_version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        row.id,
        row.title,
        row.content,
        row.content_html,
        row.category,
        row.tags,
        row.timezone,
        row.starts_at,
        row.is_repeating,
        row.repeat_every,
        row.repeat_unit,
        row.enabled,
        row.completed,
        row.next_run_at,
        row.created_at,
        row.updated_at,
      );
    const linkStmt = this.database.db.prepare(
      'INSERT INTO reminder_channels (reminder_id, channel_id) VALUES (?, ?)',
    );
    for (const channelId of channelIds) {
      linkStmt.run(row.id, channelId);
    }
  }

  update(
    id: string,
    fields: {
      title: string;
      content: string;
      content_html: string | null;
      category: string;
      tags: string;
      timezone: string | null;
      starts_at: number;
      is_repeating: number;
      repeat_every: number | null;
      repeat_unit: RepeatUnit | null;
      enabled: number;
      completed: number;
      next_run_at: number;
      updated_at: number;
    },
    channelIds: string[],
  ): boolean {
    const info = this.database.db
      .prepare(
        `UPDATE reminders SET
           title = ?, content = ?, content_html = ?, category = ?, tags = ?, timezone = ?,
           starts_at = ?, is_repeating = ?, repeat_every = ?, repeat_unit = ?,
           enabled = ?, completed = ?, next_run_at = ?,
           schedule_version = schedule_version + 1, updated_at = ?
         WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(
        fields.title,
        fields.content,
        fields.content_html,
        fields.category,
        fields.tags,
        fields.timezone,
        fields.starts_at,
        fields.is_repeating,
        fields.repeat_every,
        fields.repeat_unit,
        fields.enabled,
        fields.completed,
        fields.next_run_at,
        fields.updated_at,
        id,
      );
    if (info.changes === 0) return false;

    this.database.db.prepare('DELETE FROM reminder_channels WHERE reminder_id = ?').run(id);
    const linkStmt = this.database.db.prepare(
      'INSERT INTO reminder_channels (reminder_id, channel_id) VALUES (?, ?)',
    );
    for (const channelId of channelIds) {
      linkStmt.run(id, channelId);
    }
    return true;
  }

  softDelete(id: string, now: number): boolean {
    const info = this.database.db
      .prepare(
        `UPDATE reminders SET enabled = 0, deleted_at = ?, schedule_version = schedule_version + 1, updated_at = ?
         WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(now, now, id);
    if (info.changes === 0) return false;
    this.database.db.prepare('DELETE FROM reminder_channels WHERE reminder_id = ?').run(id);
    return true;
  }

  setEnabledAndNextRun(id: string, enabled: number, nextRunAt: number, now: number): boolean {
    const info = this.database.db
      .prepare(
        `UPDATE reminders SET enabled = ?, next_run_at = ?, schedule_version = schedule_version + 1, updated_at = ?
         WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(enabled, nextRunAt, now, id);
    return info.changes > 0;
  }

  replaceChannels(reminderId: string, channelIds: string[], now: number): boolean {
    const info = this.database.db
      .prepare('UPDATE reminders SET schedule_version = schedule_version + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(now, reminderId);
    if (info.changes === 0) return false;
    this.database.db.prepare('DELETE FROM reminder_channels WHERE reminder_id = ?').run(reminderId);
    const linkStmt = this.database.db.prepare(
      'INSERT INTO reminder_channels (reminder_id, channel_id) VALUES (?, ?)',
    );
    for (const channelId of channelIds) {
      linkStmt.run(reminderId, channelId);
    }
    return true;
  }

  /** Optimistic advance used by the scheduler inside a transaction. */
  advanceSingleToCompleted(id: string, expectedNextRunAt: number, expectedVersion: number, now: number): boolean {
    const info = this.database.db
      .prepare(
        `UPDATE reminders
         SET enabled = 0, completed = 1, schedule_version = schedule_version + 1, updated_at = ?
         WHERE id = ? AND next_run_at = ? AND schedule_version = ?
           AND enabled = 1 AND completed = 0 AND deleted_at IS NULL`,
      )
      .run(now, id, expectedNextRunAt, expectedVersion);
    return info.changes > 0;
  }

  advanceRepeating(
    id: string,
    expectedNextRunAt: number,
    expectedVersion: number,
    newNextRunAt: number,
    now: number,
  ): boolean {
    const info = this.database.db
      .prepare(
        `UPDATE reminders
         SET next_run_at = ?, schedule_version = schedule_version + 1, updated_at = ?
         WHERE id = ? AND next_run_at = ? AND schedule_version = ?
           AND enabled = 1 AND completed = 0 AND deleted_at IS NULL`,
      )
      .run(newNextRunAt, now, id, expectedNextRunAt, expectedVersion);
    return info.changes > 0;
  }
}
