import { buildChunkedInStatements } from '../db/chunking';
import type { DbAdapter } from '../ports/index';

export interface ChannelRow {
  id: string;
  name: string;
  type: string;
  enabled: number;
  config: string | null;
  proxy_id: string | null;
  created_at: number;
  updated_at: number;
}

export class ChannelsRepository {
  constructor(private readonly db: DbAdapter) {}

  async findAll(): Promise<ChannelRow[]> {
    return this.db.all<ChannelRow>({
      sql: 'SELECT id, name, type, enabled, config, proxy_id, created_at, updated_at FROM channels ORDER BY created_at ASC, name ASC',
    });
  }

  async findById(id: string): Promise<ChannelRow | null> {
    return this.db.first<ChannelRow>({
      sql: 'SELECT id, name, type, enabled, config, proxy_id, created_at, updated_at FROM channels WHERE id = ?',
      params: [id],
    });
  }

  async findByIds(ids: readonly string[]): Promise<ChannelRow[]> {
    if (!ids.length) return [];
    const stmts = buildChunkedInStatements(
      'SELECT id, name, type, enabled, config, proxy_id, created_at, updated_at FROM channels WHERE id IN ',
      '',
      ids,
      this.db.maxBindParams,
    );
    const results = await this.db.batchQuery<ChannelRow>(stmts);
    return results.flat();
  }

  async countAll(): Promise<number> {
    const row = await this.db.first<{ count: number }>({
      sql: 'SELECT COUNT(*) AS count FROM channels',
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
      sql: 'UPDATE channels SET name = ?, enabled = ?, config = ?, proxy_id = ?, updated_at = ? WHERE id = ?',
      params: [fields.name, fields.enabled, fields.config, fields.proxy_id, fields.updated_at, id],
    });
    return info.changes > 0;
  }

  async usageCounts(id: string): Promise<{ reminderCount: number; deliveryCount: number }> {
    const row = await this.db.first<{ reminder_count: number; delivery_count: number }>({
      sql: `SELECT
              (SELECT COUNT(*) FROM reminder_channels WHERE channel_id = ?) AS reminder_count,
              (SELECT COUNT(*) FROM deliveries WHERE channel_id = ?) AS delivery_count`,
      params: [id, id],
    });
    return {
      reminderCount: Number(row?.reminder_count ?? 0),
      deliveryCount: Number(row?.delivery_count ?? 0),
    };
  }

  async delete(id: string): Promise<boolean> {
    const info = await this.db.run({
      sql: 'DELETE FROM channels WHERE id = ?',
      params: [id],
    });
    return info.changes > 0;
  }
}
