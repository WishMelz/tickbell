import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

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

@Injectable()
export class ChannelsRepository {
  constructor(private readonly database: DatabaseService) {}

  findAll(): ChannelRow[] {
    return this.database.db
      .prepare('SELECT id, name, type, enabled, config, proxy_id, created_at, updated_at FROM channels ORDER BY created_at ASC, name ASC')
      .all() as ChannelRow[];
  }

  findById(id: string): ChannelRow | null {
    const row = this.database.db
      .prepare('SELECT id, name, type, enabled, config, proxy_id, created_at, updated_at FROM channels WHERE id = ?')
      .get(id) as ChannelRow | undefined;
    return row ?? null;
  }

  findByIds(ids: string[]): ChannelRow[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.database.db
      .prepare(`SELECT id, name, type, enabled, config, proxy_id, created_at, updated_at FROM channels WHERE id IN (${placeholders})`)
      .all(...ids) as ChannelRow[];
  }

  countAll(): number {
    const row = this.database.db.prepare('SELECT COUNT(*) AS count FROM channels').get() as { count: number };
    return row.count;
  }

  insert(row: ChannelRow): void {
    this.database.db
      .prepare(
        `INSERT INTO channels (id, name, type, enabled, config, proxy_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.name, row.type, row.enabled, row.config, row.proxy_id, row.created_at, row.updated_at);
  }

  update(
    id: string,
    fields: { name: string; enabled: number; config: string | null; proxy_id: string | null; updated_at: number },
  ): boolean {
    const info = this.database.db
      .prepare('UPDATE channels SET name = ?, enabled = ?, config = ?, proxy_id = ?, updated_at = ? WHERE id = ?')
      .run(fields.name, fields.enabled, fields.config, fields.proxy_id, fields.updated_at, id);
    return info.changes > 0;
  }

  usageCounts(id: string): { reminderCount: number; deliveryCount: number } {
    const row = this.database.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM reminder_channels WHERE channel_id = ?) AS reminder_count,
           (SELECT COUNT(*) FROM deliveries WHERE channel_id = ?) AS delivery_count`,
      )
      .get(id, id) as { reminder_count: number; delivery_count: number };
    return { reminderCount: row.reminder_count, deliveryCount: row.delivery_count };
  }

  delete(id: string): boolean {
    const info = this.database.db.prepare('DELETE FROM channels WHERE id = ?').run(id);
    return info.changes > 0;
  }
}
