import * as fs from 'node:fs';
import * as path from 'node:path';
import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import Database from 'better-sqlite3';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';

@Injectable()
export class DatabaseService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseService.name);
  private connection: Database.Database | null = null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  get db(): Database.Database {
    if (!this.connection) {
      this.open();
    }
    return this.connection!;
  }

  onModuleInit(): void {
    this.open();
  }

  onApplicationShutdown(): void {
    this.close();
  }

  private open(): void {
    if (this.connection) return;
    const dbPath = this.config.dbPath;
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    const db = new Database(dbPath);
    if (dbPath !== ':memory:') {
      db.pragma('journal_mode = WAL');
    }
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    this.connection = db;
    this.runMigrations(db);
    this.logger.log({ dbPath }, 'SQLite database ready');
  }

  private resolveMigrationsDir(): string {
    const candidates = [
      path.resolve(__dirname, '../../../migrations'),
      path.resolve(__dirname, '../../migrations'),
      path.resolve(process.cwd(), 'migrations'),
      path.resolve(process.cwd(), 'server/migrations'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    }
    throw new Error(`Migrations directory not found. Checked: ${candidates.join(', ')}`);
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

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      const apply = db.transaction(() => {
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(file, Date.now());
      });
      apply();
      this.logger.log({ migration: file }, 'Applied SQLite migration');
    }
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  ping(): boolean {
    try {
      const row = this.db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
      return row?.ok === 1;
    } catch {
      return false;
    }
  }

  vacuumInto(targetPath: string): void {
    if (targetPath.includes('\0')) {
      throw new Error('Invalid backup path');
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    if (fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
    }
    const escaped = targetPath.replace(/'/g, "''");
    this.db.exec(`VACUUM INTO '${escaped}'`);
  }

  optimize(): void {
    this.db.pragma('optimize');
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
