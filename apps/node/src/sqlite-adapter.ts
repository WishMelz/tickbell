import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CoreLogger, DbAdapter, DbRunResult, SqlStatement } from '@tickbell/core';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class SqliteDbAdapter implements DbAdapter {
  readonly maxBindParams = 500;
  private connection: Database.Database | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly migrationsDir: string,
    private readonly logger: CoreLogger,
  ) {}

  get raw(): Database.Database {
    if (!this.connection) this.open();
    return this.connection!;
  }

  open(): void {
    if (this.connection) return;
    if (this.dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    }
    const db = new Database(this.dbPath);
    if (this.dbPath !== ':memory:') {
      db.pragma('journal_mode = WAL');
    }
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    this.connection = db;
    this.runMigrations(db);
    this.logger.info({ dbPath: this.dbPath }, 'SQLite database ready');
  }

  private resolveMigrationsDir(): string {
    const candidates = [
      this.migrationsDir,
      path.resolve(__dirname, '../../../migrations/sqlite'),
      path.resolve(__dirname, '../../migrations/sqlite'),
      path.resolve(__dirname, '../migrations/sqlite'),
      path.resolve(process.cwd(), 'migrations/sqlite'),
      path.resolve(process.cwd(), '../../migrations/sqlite'),
    ].filter(Boolean);
    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    }
    throw new Error(`SQLite migrations directory not found. Checked: ${candidates.join(', ')}`);
  }

  private runMigrations(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);
    const dir = this.resolveMigrationsDir();
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.sql'))
      .sort();

    const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: string }>;
    const applied = new Set(appliedRows.map((row) => row.version));
    const pending = files.filter((file) => !applied.has(file));
    if (!pending.length) return;

    db.pragma('foreign_keys = OFF');
    try {
      for (const file of pending) {
        const sql = fs.readFileSync(path.join(dir, file), 'utf8');
        const apply = db.transaction(() => {
          db.exec(sql);
          const violations = db.pragma('foreign_key_check') as unknown[];
          if (violations.length > 0) {
            throw new Error(`Migration ${file} introduced foreign key violations: ${JSON.stringify(violations)}`);
          }
          db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(file, Date.now());
        });
        apply();
        this.logger.info({ migration: file }, 'Applied SQLite migration');
      }
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }

  async all<T = Record<string, unknown>>(stmt: SqlStatement): Promise<T[]> {
    const prepared = this.raw.prepare(stmt.sql);
    const params = stmt.params ?? [];
    return (params.length ? prepared.all(...params) : prepared.all()) as T[];
  }

  async first<T = Record<string, unknown>>(stmt: SqlStatement): Promise<T | null> {
    const prepared = this.raw.prepare(stmt.sql);
    const params = stmt.params ?? [];
    const row = (params.length ? prepared.get(...params) : prepared.get()) as T | undefined;
    return row ?? null;
  }

  async run(stmt: SqlStatement): Promise<DbRunResult> {
    const prepared = this.raw.prepare(stmt.sql);
    const params = stmt.params ?? [];
    const info = params.length ? prepared.run(...params) : prepared.run();
    return { changes: info.changes };
  }

  async batch(stmts: readonly SqlStatement[]): Promise<DbRunResult[]> {
    if (stmts.length === 0) return [];
    const execTx = this.raw.transaction(() => {
      const results: DbRunResult[] = [];
      for (const stmt of stmts) {
        const prepared = this.raw.prepare(stmt.sql);
        const params = stmt.params ?? [];
        const info = params.length ? prepared.run(...params) : prepared.run();
        results.push({ changes: info.changes });
      }
      return results;
    });
    return execTx();
  }

  async batchQuery<T = Record<string, unknown>>(stmts: readonly SqlStatement[]): Promise<T[][]> {
    if (stmts.length === 0) return [];
    const execTx = this.raw.transaction(() => {
      const results: T[][] = [];
      for (const stmt of stmts) {
        const prepared = this.raw.prepare(stmt.sql);
        const params = stmt.params ?? [];
        results.push((params.length ? prepared.all(...params) : prepared.all()) as T[]);
      }
      return results;
    });
    return execTx();
  }

  async ping(): Promise<boolean> {
    try {
      const row = this.raw.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
      return row?.ok === 1;
    } catch {
      return false;
    }
  }

  vacuumInto(targetPath: string): void {
    if (targetPath.includes('\0')) throw new Error('Invalid backup path');
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
    const escaped = targetPath.replace(/'/g, "''");
    this.raw.exec(`VACUUM INTO '${escaped}'`);
  }

  optimize(): void {
    this.raw.pragma('optimize');
  }

  close(): void {
    if (this.connection) {
      try {
        this.connection.close();
      } finally {
        this.connection = null;
      }
    }
  }
}
