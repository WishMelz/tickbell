import { buildChunkedInStatements } from '../db/chunking';
import type { DbAdapter } from '../ports/index';

export interface ChannelRow {
  id: string;
  name: string;
  type: string;
  enabled: number;
  config: string | null;
  proxy_id: string | null;
  deleted_at?: number | null;
  created_at: number;
  updated_at: number;
}

export class ChannelsRepository {
  constructor(private readonly db: DbAdapter) {}

  async findAll(): Promise<ChannelRow[]> {
    return this.db.all<ChannelRow>({
      sql: 'SELECT id, name, type, enabled, config, proxy_id, deleted_at, created_at, updated_at FROM channels WHERE deleted_at IS NULL ORDER BY created_at ASC, name ASC',
    });
  }

  async findById(id: string, includeDeleted = false): Promise<ChannelRow | null> {
    return this.db.first<ChannelRow>({
      sql: includeDeleted
        ? 'SELECT id, name, type, enabled, config, proxy_id, deleted_at, created_at, updated_at FROM channels WHERE id = ?'
        : 'SELECT id, name, type, enabled, config, proxy_id, deleted_at, created_at, updated_at FROM channels WHERE id = ? AND deleted_at IS NULL',
      params: [id],
    });
  }

  async findByIds(ids: readonly string[], includeDeleted = false): Promise<ChannelRow[]> {
    if (!ids.length) return [];
    const stmts = buildChunkedInStatements(
      'SELECT id, name, type, enabled, config, proxy_id, deleted_at, created_at, updated_at FROM channels WHERE id IN ',
      includeDeleted ? '' : ' AND deleted_at IS NULL',
      ids,
      this.db.maxBindParams,
    );
    const results = await this.db.batchQuery<ChannelRow>(stmts);
    return results.flat();
  }

  async countAll(): Promise<number> {
    const row = await this.db.first<{ count: number }>({
      sql: 'SELECT COUNT(*) AS count FROM channels WHERE deleted_at IS NULL',
    });
    return Number(row?.count ?? 0);
  }

  async insert(row: ChannelRow): Promise<void> {
    await this.db.run({
      sql: `INSERT INTO channels (id, name, type, enabled, config, proxy_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        row.id,
        row.name,
        row.type,
        row.enabled,
        row.config,
        row.proxy_id,
        row.created_at,
        row.updated_at,
      ],
    });
  }

  async update(
    id: string,
    fields: { name: string; enabled: number; config: string | null; proxy_id: string | null; updated_at: number },
  ): Promise<boolean> {
    const info = await this.db.run({
      sql: 'UPDATE channels SET name = ?, enabled = ?, config = ?, proxy_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
      params: [fields.name, fields.enabled, fields.config, fields.proxy_id, fields.updated_at, id],
    });
    return info.changes > 0;
  }

  async usageCounts(id: string): Promise<{ activeReminderCount: number; deliveryCount: number }> {
    const row = await this.db.first<{ active_reminder_count: number; delivery_count: number }>({
      sql: `SELECT
              (SELECT COUNT(*)
               FROM reminder_channels rc
               JOIN reminders r ON r.id = rc.reminder_id
               WHERE rc.channel_id = ? AND r.deleted_at IS NULL) AS active_reminder_count,
              (SELECT COUNT(*) FROM deliveries WHERE channel_id = ?) AS delivery_count`,
      params: [id, id],
    });
    return {
      activeReminderCount: Number(row?.active_reminder_count ?? 0),
      deliveryCount: Number(row?.delivery_count ?? 0),
    };
  }

  /**
   * Soft-deletes a channel that still has historical delivery logs:
   * scrubs credentials (`config = NULL`), releases `proxy_id`, disables it, and clears stale links
   * from already soft-deleted reminders while preserving `name`/`type` for delivery log display.
   */
  async softDelete(id: string, now: number): Promise<boolean> {
    const results = await this.db.batch([
      {
        sql: 'DELETE FROM reminder_channels WHERE channel_id = ?',
        params: [id],
      },
      {
        sql: `UPDATE channels
              SET deleted_at = ?, enabled = 0, config = NULL, proxy_id = NULL, updated_at = ?
              WHERE id = ? AND deleted_at IS NULL`,
        params: [now, now, id],
      },
    ]);
    return (results[1]?.changes ?? 0) > 0;
  }

  /** Hard-deletes a channel with no active reminders and no historical delivery logs. */
  async delete(id: string): Promise<boolean> {
    const results = await this.db.batch([
      {
        sql: 'DELETE FROM reminder_channels WHERE channel_id = ?',
        params: [id],
      },
      {
        sql: 'DELETE FROM channels WHERE id = ?',
        params: [id],
      },
    ]);
    return (results[1]?.changes ?? 0) > 0;
  }
}
