import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type { ProxyProtocol } from '../notifications/http/proxy-dispatcher';

export interface ProxyRow {
  id: string;
  name: string;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username: string;
  password: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

@Injectable()
export class ProxiesRepository {
  constructor(private readonly database: DatabaseService) {}

  findAll(): ProxyRow[] {
    return this.database.db
      .prepare(
        `SELECT id, name, protocol, host, port, username, password, enabled, created_at, updated_at
         FROM proxies
         ORDER BY created_at ASC, name ASC`,
      )
      .all() as ProxyRow[];
  }

  findById(id: string): ProxyRow | null {
    const row = this.database.db
      .prepare(
        `SELECT id, name, protocol, host, port, username, password, enabled, created_at, updated_at
         FROM proxies
         WHERE id = ?`,
      )
      .get(id) as ProxyRow | undefined;
    return row ?? null;
  }

  countChannelsByProxy(): Map<string, number> {
    const rows = this.database.db
      .prepare(
        `SELECT proxy_id, COUNT(*) AS cnt
         FROM channels
         WHERE proxy_id IS NOT NULL
         GROUP BY proxy_id`,
      )
      .all() as Array<{ proxy_id: string; cnt: number }>;
    const map = new Map<string, number>();
    for (const row of rows) {
      map.set(row.proxy_id, row.cnt);
    }
    return map;
  }

  countChannelsForProxy(id: string): number {
    const row = this.database.db
      .prepare('SELECT COUNT(*) AS cnt FROM channels WHERE proxy_id = ?')
      .get(id) as { cnt: number };
    return row.cnt;
  }

  insert(row: ProxyRow): void {
    this.database.db
      .prepare(
        `INSERT INTO proxies (id, name, protocol, host, port, username, password, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.name,
        row.protocol,
        row.host,
        row.port,
        row.username,
        row.password,
        row.enabled,
        row.created_at,
        row.updated_at,
      );
  }

  update(
    id: string,
    fields: {
      name: string;
      protocol: ProxyProtocol;
      host: string;
      port: number;
      username: string;
      password: string;
      enabled: number;
      updated_at: number;
    },
  ): boolean {
    const info = this.database.db
      .prepare(
        `UPDATE proxies
         SET name = ?, protocol = ?, host = ?, port = ?, username = ?, password = ?, enabled = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        fields.name,
        fields.protocol,
        fields.host,
        fields.port,
        fields.username,
        fields.password,
        fields.enabled,
        fields.updated_at,
        id,
      );
    return info.changes > 0;
  }

  delete(id: string): boolean {
    const info = this.database.db.prepare('DELETE FROM proxies WHERE id = ?').run(id);
    return info.changes > 0;
  }
}
