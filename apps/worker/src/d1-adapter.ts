import type { D1Database } from '@cloudflare/workers-types';
import type { DbAdapter, DbRunResult, SqlStatement } from '@tickbell/core';
import { ensureD1Schema, resetD1SchemaCache } from './d1-schema';

function isMissingTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /no such table/i.test(message);
}

/**
 * Cloudflare D1 implementation of `DbAdapter`.
 * - Enforces `maxBindParams = 90` (safely under D1's hard 100 bound parameters per statement limit).
 * - Self-heals if tables were dropped or swapped on a warm Worker isolate by re-running `ensureD1Schema`
 *   and retrying the failed operation once.
 */
export class D1DbAdapter implements DbAdapter {
  readonly maxBindParams = 90;

  constructor(private readonly db: D1Database) {}

  private prepare(stmt: SqlStatement) {
    const prepared = this.db.prepare(stmt.sql);
    return stmt.params && stmt.params.length > 0 ? prepared.bind(...stmt.params) : prepared;
  }

  private async withSchemaSelfHeal<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!isMissingTableError(error)) {
        throw error;
      }
      resetD1SchemaCache();
      await ensureD1Schema(this.db);
      return operation();
    }
  }

  async all<T = Record<string, unknown>>(stmt: SqlStatement): Promise<T[]> {
    return this.withSchemaSelfHeal(async () => {
      const res = await this.prepare(stmt).all<T>();
      return res.results ?? [];
    });
  }

  async first<T = Record<string, unknown>>(stmt: SqlStatement): Promise<T | null> {
    return this.withSchemaSelfHeal(async () => {
      const row = await this.prepare(stmt).first<T>();
      return row ?? null;
    });
  }

  async run(stmt: SqlStatement): Promise<DbRunResult> {
    return this.withSchemaSelfHeal(async () => {
      const res = await this.prepare(stmt).run();
      return { changes: Number(res.meta?.changes ?? 0) };
    });
  }

  async batch(stmts: readonly SqlStatement[]): Promise<DbRunResult[]> {
    if (stmts.length === 0) return [];
    return this.withSchemaSelfHeal(async () => {
      const results = await this.db.batch(stmts.map((stmt) => this.prepare(stmt)));
      return results.map((res) => ({ changes: Number(res.meta?.changes ?? 0) }));
    });
  }

  async batchQuery<T = Record<string, unknown>>(stmts: readonly SqlStatement[]): Promise<T[][]> {
    if (stmts.length === 0) return [];
    return this.withSchemaSelfHeal(async () => {
      const results = await this.db.batch<T>(stmts.map((stmt) => this.prepare(stmt)));
      return results.map((res) => res.results ?? []);
    });
  }

  async ping(): Promise<boolean> {
    try {
      const row = await this.first<{ ok: number }>({ sql: 'SELECT 1 AS ok' });
      return Number(row?.ok) === 1;
    } catch {
      return false;
    }
  }
}
