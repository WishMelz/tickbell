import type { DbAdapter, ProxyProtocol } from '../ports/index';

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

export class ProxiesRepository {
  constructor(private readonly db: DbAdapter) {}

  async findAll(): Promise<ProxyRow[]> {
    return this.db.all<ProxyRow>({
      sql: `SELECT id, name, protocol, host, port, username, password, enabled, created_at, updated_at
            FROM proxies
            ORDER BY created_at ASC, name ASC`,
    });
  }

  async findById(id: string): Promise<ProxyRow | null> {
    return this.db.first<ProxyRow>({
      sql: `SELECT id, name, protocol, host, port, username, password, enabled, created_at, updated_at
            FROM proxies
            WHERE id = ?`,
      params: [id],
    });
  }

  async countChannelsByProxy(): Promise<Map<string, number>> {
    const rows = await this.db.all<{ proxy_id: string; cnt: number }>({
      sql: `SELECT proxy_id, COUNT(*) AS cnt
            FROM channels
            WHERE proxy_id IS NOT NULL AND deleted_at IS NULL
            GROUP BY proxy_id`,
    });
    const map = new Map<string, number>();
    for (const row of rows) {
      map.set(row.proxy_id, Number(row.cnt));
    }
    return map;
  }

  async countChannelsForProxy(id: string): Promise<number> {
    const row = await this.db.first<{ cnt: number }>({
      sql: 'SELECT COUNT(*) AS cnt FROM channels WHERE proxy_id = ? AND deleted_at IS NULL',
      params: [id],
    });
    return Number(row?.cnt ?? 0);
  }

  async insert(row: ProxyRow): Promise<void> {
    await this.db.run({
      sql: `INSERT INTO proxies (id, name, protocol, host, port, username, password, enabled, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
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
      ],
    });
  }

  async update(
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
  ): Promise<boolean> {
    const info = await this.db.run({
      sql: `UPDATE proxies
            SET name = ?, protocol = ?, host = ?, port = ?, username = ?, password = ?, enabled = ?, updated_at = ?
            WHERE id = ?`,
      params: [
        fields.name,
        fields.protocol,
        fields.host,
        fields.port,
        fields.username,
        fields.password,
        fields.enabled,
        fields.updated_at,
        id,
      ],
    });
    return info.changes > 0;
  }

  async delete(id: string): Promise<boolean> {
    const info = await this.db.run({
      sql: 'DELETE FROM proxies WHERE id = ?',
      params: [id],
    });
    return info.changes > 0;
  }
}
