import type { RepeatUnit } from '../common/repeat';
import { buildChunkedInStatements, buildMultiRowInsertStatements } from '../db/chunking';
import type { DbAdapter, SqlStatement } from '../ports/index';

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
  sort?: 'asc' | 'desc';
}

function buildFilterWhere(filters: ReminderListFilters): { where: string; params: unknown[] } {
  const conditions: string[] = ['deleted_at IS NULL'];
  const params: unknown[] = [];

  if (filters.search) {
    conditions.push(`(
      title LIKE ? OR content LIKE ? OR category LIKE ?
      OR EXISTS (SELECT 1 FROM json_each(reminders.tags) WHERE value LIKE ?)
    )`);
    const pattern = `%${filters.search}%`;
    params.push(pattern, pattern, pattern, pattern);
  }
  if (filters.category) {
    conditions.push('category = ?');
    params.push(filters.category);
  }
  if (filters.tag) {
    conditions.push('EXISTS (SELECT 1 FROM json_each(reminders.tags) WHERE value = ?)');
    params.push(filters.tag);
  }
  if (filters.status === 'active') {
    conditions.push('enabled = 1 AND completed = 0');
  } else if (filters.status === 'paused') {
    conditions.push('enabled = 0 AND completed = 0');
  } else if (filters.status === 'completed') {
    conditions.push('completed = 1');
  }

  return { where: conditions.join(' AND '), params };
}

export class RemindersRepository {
  constructor(private readonly db: DbAdapter) {}

  async findAll(filters: ReminderListFilters): Promise<ReminderRow[]> {
    const { where, params } = buildFilterWhere(filters);
    const dir = filters.sort === 'desc' ? 'DESC' : 'ASC';
    return this.db.all<ReminderRow>({
      sql: `SELECT * FROM reminders WHERE ${where} ORDER BY next_run_at ${dir}`,
      params,
    });
  }

  async findPage(
    filters: ReminderListFilters,
    page: number,
    pageSize: number,
  ): Promise<{ items: ReminderRow[]; total: number }> {
    const { where, params } = buildFilterWhere(filters);
    const dir = filters.sort === 'desc' ? 'DESC' : 'ASC';
    const offset = (page - 1) * pageSize;
    const [countRows, itemRows] = await this.db.batchQuery<Record<string, unknown>>([
      {
        sql: `SELECT COUNT(*) AS count FROM reminders WHERE ${where}`,
        params,
      },
      {
        sql: `SELECT * FROM reminders WHERE ${where} ORDER BY next_run_at ${dir} LIMIT ? OFFSET ?`,
        params: [...params, pageSize, offset],
      },
    ]);
    const total = Number((countRows?.[0] as { count?: number } | undefined)?.count ?? 0);
    return {
      items: (itemRows ?? []) as unknown as ReminderRow[],
      total,
    };
  }

  async listFacets(): Promise<{ categories: string[]; tags: string[] }> {
    const [catRows, tagRows] = await this.db.batchQuery<{ val: string }>([
      {
        sql: `SELECT DISTINCT category AS val FROM reminders WHERE deleted_at IS NULL AND category != '' ORDER BY category ASC`,
      },
      {
        sql: `SELECT DISTINCT j.value AS val
              FROM reminders r, json_each(r.tags) j
              WHERE r.deleted_at IS NULL AND typeof(j.value) = 'text' AND j.value != ''
              ORDER BY j.value ASC`,
      },
    ]);
    return {
      categories: (catRows ?? []).map((r) => r.val),
      tags: (tagRows ?? []).map((r) => r.val),
    };
  }

  async findById(id: string, includeDeleted = false): Promise<ReminderRow | null> {
    const sql = includeDeleted
      ? 'SELECT * FROM reminders WHERE id = ?'
      : 'SELECT * FROM reminders WHERE id = ? AND deleted_at IS NULL';
    return this.db.first<ReminderRow>({ sql, params: [id] });
  }

  async findByIds(ids: readonly string[]): Promise<ReminderRow[]> {
    if (!ids.length) return [];
    const stmts = buildChunkedInStatements(
      'SELECT * FROM reminders WHERE id IN ',
      ' AND deleted_at IS NULL',
      ids,
      this.db.maxBindParams,
    );
    const results = await this.db.batchQuery<ReminderRow>(stmts);
    return results.flat();
  }

  async findInheritedGlobalTimezone(): Promise<Array<{ id: string; starts_at: number; next_run_at: number; schedule_version: number }>> {
    return this.db.all({
      sql: `SELECT id, starts_at, next_run_at, schedule_version FROM reminders
            WHERE timezone IS NULL AND deleted_at IS NULL`,
    });
  }

  async countActive(): Promise<number> {
    const row = await this.db.first<{ count: number }>({
      sql: 'SELECT COUNT(*) AS count FROM reminders WHERE deleted_at IS NULL',
    });
    return Number(row?.count ?? 0);
  }

  async countEnabledActive(): Promise<number> {
    const row = await this.db.first<{ count: number }>({
      sql: 'SELECT COUNT(*) AS count FROM reminders WHERE deleted_at IS NULL AND enabled = 1 AND completed = 0',
    });
    return Number(row?.count ?? 0);
  }

  /** Uses a single JOIN query when fetching all active links, avoiding large IN clauses. */
  async getAllActiveChannelIdsMap(): Promise<Map<string, string[]>> {
    const rows = await this.db.all<{ reminder_id: string; channel_id: string }>({
      sql: `SELECT rc.reminder_id, rc.channel_id
            FROM reminder_channels rc
            INNER JOIN reminders r ON r.id = rc.reminder_id
            WHERE r.deleted_at IS NULL
            ORDER BY rc.channel_id`,
    });
    const map = new Map<string, string[]>();
    for (const row of rows) {
      const list = map.get(row.reminder_id);
      if (list) list.push(row.channel_id);
      else map.set(row.reminder_id, [row.channel_id]);
    }
    return map;
  }

  async getChannelIdsMap(reminderIds: readonly string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (!reminderIds.length) return map;
    const stmts = buildChunkedInStatements(
      'SELECT reminder_id, channel_id FROM reminder_channels WHERE reminder_id IN ',
      ' ORDER BY channel_id',
      reminderIds,
      this.db.maxBindParams,
    );
    const batches = await this.db.batchQuery<{ reminder_id: string; channel_id: string }>(stmts);
    for (const rows of batches) {
      for (const row of rows) {
        const list = map.get(row.reminder_id);
        if (list) list.push(row.channel_id);
        else map.set(row.reminder_id, [row.channel_id]);
      }
    }
    return map;
  }

  async getChannelIds(reminderId: string): Promise<string[]> {
    const rows = await this.db.all<{ channel_id: string }>({
      sql: 'SELECT channel_id FROM reminder_channels WHERE reminder_id = ? ORDER BY channel_id',
      params: [reminderId],
    });
    return rows.map((row) => row.channel_id);
  }

  async findDue(now: number, limit = 50): Promise<DueReminderRow[]> {
    return this.db.all<DueReminderRow>({
      sql: `SELECT reminders.*, COALESCE(timezone,
              (SELECT value FROM settings WHERE key = 'global_timezone'), 'UTC') AS effective_timezone
            FROM reminders
            WHERE enabled = 1 AND completed = 0 AND deleted_at IS NULL AND next_run_at <= ?
            ORDER BY next_run_at ASC
            LIMIT ?`,
      params: [now, limit],
    });
  }

  insertStatements(
    row: Omit<ReminderRow, 'deleted_at' | 'schedule_version'>,
    channelIds: readonly string[],
  ): SqlStatement[] {
    const stmts: SqlStatement[] = [
      {
        sql: `INSERT INTO reminders (
                id, title, content, content_html, category, tags, timezone,
                starts_at, is_repeating, repeat_every, repeat_unit,
                enabled, completed, next_run_at, schedule_version, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        params: [
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
        ],
      },
    ];
    if (channelIds.length) {
      stmts.push(
        ...buildMultiRowInsertStatements(
          'reminder_channels',
          ['reminder_id', 'channel_id'],
          channelIds.map((cid) => [row.id, cid]),
          this.db.maxBindParams,
        ),
      );
    }
    return stmts;
  }

  updateStatements(
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
    channelIds: readonly string[],
  ): SqlStatement[] {
    const stmts: SqlStatement[] = [
      {
        sql: `UPDATE reminders SET
                title = ?, content = ?, content_html = ?, category = ?, tags = ?, timezone = ?,
                starts_at = ?, is_repeating = ?, repeat_every = ?, repeat_unit = ?,
                enabled = ?, completed = ?, next_run_at = ?,
                schedule_version = schedule_version + 1, updated_at = ?
              WHERE id = ? AND deleted_at IS NULL`,
        params: [
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
        ],
      },
      {
        sql: 'DELETE FROM reminder_channels WHERE reminder_id = ?',
        params: [id],
      },
    ];
    if (channelIds.length) {
      stmts.push(
        ...buildMultiRowInsertStatements(
          'reminder_channels',
          ['reminder_id', 'channel_id'],
          channelIds.map((cid) => [id, cid]),
          this.db.maxBindParams,
        ),
      );
    }
    return stmts;
  }

  softDeleteStatements(id: string, now: number): SqlStatement[] {
    return [
      {
        sql: `UPDATE reminders SET enabled = 0, deleted_at = ?, schedule_version = schedule_version + 1, updated_at = ?
              WHERE id = ? AND deleted_at IS NULL`,
        params: [now, now, id],
      },
      {
        sql: 'DELETE FROM reminder_channels WHERE reminder_id = ?',
        params: [id],
      },
    ];
  }

  setEnabledAndNextRunStatement(id: string, enabled: number, nextRunAt: number, now: number): SqlStatement {
    return {
      sql: `UPDATE reminders SET enabled = ?, next_run_at = ?, schedule_version = schedule_version + 1, updated_at = ?
            WHERE id = ? AND deleted_at IS NULL`,
      params: [enabled, nextRunAt, now, id],
    };
  }

  replaceChannelsStatements(reminderId: string, channelIds: readonly string[], now: number): SqlStatement[] {
    const stmts: SqlStatement[] = [
      {
        sql: 'UPDATE reminders SET schedule_version = schedule_version + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
        params: [now, reminderId],
      },
      {
        sql: 'DELETE FROM reminder_channels WHERE reminder_id = ?',
        params: [reminderId],
      },
    ];
    if (channelIds.length) {
      stmts.push(
        ...buildMultiRowInsertStatements(
          'reminder_channels',
          ['reminder_id', 'channel_id'],
          channelIds.map((cid) => [reminderId, cid]),
          this.db.maxBindParams,
        ),
      );
    }
    return stmts;
  }

  advanceSingleToCompletedStatement(
    id: string,
    expectedNextRunAt: number,
    expectedVersion: number,
    now: number,
  ): SqlStatement {
    return {
      sql: `UPDATE reminders
            SET enabled = 0, completed = 1, schedule_version = schedule_version + 1, updated_at = ?
            WHERE id = ? AND next_run_at = ? AND schedule_version = ?
              AND enabled = 1 AND completed = 0 AND deleted_at IS NULL`,
      params: [now, id, expectedNextRunAt, expectedVersion],
    };
  }

  advanceRepeatingStatement(
    id: string,
    expectedNextRunAt: number,
    expectedVersion: number,
    newNextRunAt: number,
    now: number,
  ): SqlStatement {
    return {
      sql: `UPDATE reminders
            SET next_run_at = ?, schedule_version = schedule_version + 1, updated_at = ?
            WHERE id = ? AND next_run_at = ? AND schedule_version = ?
              AND enabled = 1 AND completed = 0 AND deleted_at IS NULL`,
      params: [newNextRunAt, now, id, expectedNextRunAt, expectedVersion],
    };
  }
}
