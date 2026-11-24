import type { DbAdapter, SqlStatement } from '../ports/index';

export interface SettingRow {
  key: string;
  value: string;
  updated_at: number;
}

export class SettingsRepository {
  constructor(private readonly db: DbAdapter) {}

  async get(key: string): Promise<string | null> {
    const row = await this.db.first<{ value: string }>({
      sql: 'SELECT value FROM settings WHERE key = ?',
      params: [key],
    });
    return row?.value ?? null;
  }

  async getMany(keys: readonly string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!keys.length) return map;
    const placeholders = keys.map(() => '?').join(',');
    const rows = await this.db.all<{ key: string; value: string }>({
      sql: `SELECT key, value FROM settings WHERE key IN (${placeholders})`,
      params: keys,
    });
    for (const row of rows) {
      map.set(row.key, row.value);
    }
    return map;
  }

  async getAll(): Promise<SettingRow[]> {
    return this.db.all<SettingRow>({
      sql: 'SELECT key, value, updated_at FROM settings',
    });
  }

  upsertStatement(key: string, value: string, now: number): SqlStatement {
    return {
      sql: `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      params: [key, value, now],
    };
  }

  insertIgnoreStatement(key: string, value: string, now: number): SqlStatement {
    return {
      sql: 'INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
      params: [key, value, now],
    };
  }

  async set(key: string, value: string, now = Date.now()): Promise<void> {
    await this.db.run(this.upsertStatement(key, value, now));
  }
}
