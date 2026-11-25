import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { D1Database, ExecutionContext, RateLimit, ScheduledController } from '@cloudflare/workers-types';
import { describe, expect, it, vi } from 'vitest';
import { D1_SCHEMA_STATEMENTS, resetD1SchemaCache } from '../src/d1-schema';
import workerEntry, { buildWorkerCore } from '../src/index';
import type { WorkerEnv } from '../src/env';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const D1_INIT_SQL = fs.readFileSync(path.resolve(__dirname, '../../../migrations/d1/0001_init.sql'), 'utf8');

function toSqlParams(params: unknown[]): SQLInputValue[] {
  return params as SQLInputValue[];
}

function isReaderSql(sql: string): boolean {
  const head = sql.trimStart().slice(0, 12).toUpperCase();
  return head.startsWith('SELECT') || head.startsWith('WITH') || head.startsWith('PRAGMA') || /\bRETURNING\b/i.test(sql);
}

/**
 * Strict D1 mock backed by Node's built-in in-memory `node:sqlite` (zero native C++ deps)
 * that enforces Cloudflare D1's hard 100 bound-parameter limit per SQL statement and tracks D1 query count.
 */
function createStrictMockD1(options: { preInitSchema?: boolean } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  if (options.preInitSchema !== false) {
    sqlite.exec(D1_INIT_SQL);
  }

  let queryCount = 0;

  const makeStatement = (sql: string, boundParams: unknown[] = []) => ({
    sql,
    boundParams,
    bind(...params: unknown[]) {
      if (params.length > 100) {
        throw new Error(`D1_ERROR: too many SQL variables (${params.length} > 100)`);
      }
      return makeStatement(sql, params);
    },
    async all<T>() {
      queryCount += 1;
      if (boundParams.length > 100) {
        throw new Error(`D1_ERROR: too many SQL variables (${boundParams.length} > 100)`);
      }
      const stmt = sqlite.prepare(sql);
      const results = (boundParams.length ? stmt.all(...toSqlParams(boundParams)) : stmt.all()) as T[];
      return { results, success: true, meta: { changes: 0 } };
    },
    async first<T>() {
      queryCount += 1;
      if (boundParams.length > 100) {
        throw new Error(`D1_ERROR: too many SQL variables (${boundParams.length} > 100)`);
      }
      const stmt = sqlite.prepare(sql);
      const row = (boundParams.length ? stmt.get(...toSqlParams(boundParams)) : stmt.get()) as T | undefined;
      return row ?? null;
    },
    async run() {
      queryCount += 1;
      if (boundParams.length > 100) {
        throw new Error(`D1_ERROR: too many SQL variables (${boundParams.length} > 100)`);
      }
      const stmt = sqlite.prepare(sql);
      const info = boundParams.length ? stmt.run(...toSqlParams(boundParams)) : stmt.run();
      return { success: true, meta: { changes: Number(info.changes) } };
    },
  });

  const d1 = {
    prepare(sql: string) {
      return makeStatement(sql);
    },
    async batch(stmts: Array<{ sql: string; boundParams: unknown[] }>) {
      // D1 counts an entire batch() call as 1 single query!
      queryCount += 1;
      sqlite.exec('BEGIN');
      try {
        const out = stmts.map((s) => {
          if (s.boundParams.length > 100) {
            throw new Error(`D1_ERROR: too many SQL variables (${s.boundParams.length} > 100)`);
          }
          const prepared = sqlite.prepare(s.sql);
          if (isReaderSql(s.sql)) {
            const results = s.boundParams.length ? prepared.all(...toSqlParams(s.boundParams)) : prepared.all();
            return { results, success: true, meta: { changes: 0 } };
          }
          const info = s.boundParams.length ? prepared.run(...toSqlParams(s.boundParams)) : prepared.run();
          return { results: [], success: true, meta: { changes: Number(info.changes) } };
        });
        sqlite.exec('COMMIT');
        return out;
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    },
  } as unknown as D1Database;

  return {
    d1,
    sqlite,
    getQueryCount: () => queryCount,
    resetQueryCount: () => {
      queryCount = 0;
    },
  };
}

function createMockRateLimiter(max = 5): RateLimit {
  const counts = new Map<string, number>();
  return {
    async limit({ key }: { key: string }) {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return { success: next <= max };
    },
  };
}

describe('Cloudflare Worker + strict D1 100-param integration', () => {
  it('supports zero-config setup, CF capabilities, unlimited reminders pagination, 150-item batch & restore, and budgeted Cron ticks', async () => {
    const mockD1 = createStrictMockD1();
    const env: WorkerEnv = {
      DB: mockD1.d1,
      LOGIN_RATE_LIMITER: createMockRateLimiter(20),
      CRON_MAX_DELIVERIES_PER_TICK: '10',
      CRON_MAX_RETRIES_PER_TICK: '5',
    };

    const { app, scheduler } = buildWorkerCore(env);
    const req = (pathUrl: string, init?: RequestInit) =>
      app.request(`https://tickbell.example.workers.dev${pathUrl}`, init);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = async (res: Response): Promise<any> => res.json();

    // 1. Uninitialized status & zero-config Web UI setup
    const status0 = await json(await req('/api/auth/status'));
    expect(status0.data.initialized).toBe(false);
    expect(status0.data.runtime).toBe('cloudflare');

    const setupRes = await req('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
      body: JSON.stringify({
        password: 'cf-admin-password',
        secret: '0123456789abcdef0123456789abcdef',
        globalTimezone: 'Asia/Shanghai',
      }),
    });
    expect(setupRes.status).toBe(200);
    const setCookieHeader = setupRes.headers.get('set-cookie') ?? '';
    const cookie = setCookieHeader.split(';')[0]!;
    expect(cookie).toContain('tickbell_session=');
    expect(setCookieHeader).toContain('Secure');

    const authedHeaders = { 'Content-Type': 'application/json', Cookie: cookie, 'CF-Connecting-IP': '1.2.3.4' };

    // 2. Capabilities & 501 for unsupported CF endpoints
    const sysRes = await json(await req('/api/system/status', { headers: authedHeaders }));
    expect(sysRes.data.runtime).toBe('cloudflare');
    expect(sysRes.data.capabilities.proxies).toBe(false);
    expect(sysRes.data.capabilities.diskAutoBackup).toBe(false);
    expect(sysRes.data.limits.maxReminders).toBeUndefined();

    expect((await req('/api/proxies', { headers: authedHeaders })).status).toBe(501);
    expect((await req('/api/backup/auto', { headers: authedHeaders })).status).toBe(501);

    // 3. Create Bark channel (strict public URL enforced on CF!)
    const privBark = await req('/api/channels', {
      method: 'POST',
      headers: authedHeaders,
      body: JSON.stringify({
        name: '内网 Bark',
        type: 'bark',
        enabled: true,
        config: { serverUrl: 'http://192.168.1.10:8080', deviceKey: 'dev-key' },
      }),
    });
    expect(privBark.status).toBe(400);

    const chRes = await req('/api/channels', {
      method: 'POST',
      headers: authedHeaders,
      body: JSON.stringify({
        name: '官方 Bark',
        type: 'bark',
        enabled: true,
        config: { serverUrl: 'https://api.day.app', deviceKey: 'dev-key-1' },
      }),
    });
    expect(chRes.status).toBe(201);
    const channelId = (await json(chRes)).data.id as string;

    // 4. Create 150 reminders (> D1's 100 bind-param limit!) and verify server-side pagination + batch + full restore
    const createdIds: string[] = [];
    for (let i = 0; i < 150; i += 1) {
      const hour = String(8 + (i % 10)).padStart(2, '0');
      const min = String(i % 60).padStart(2, '0');
      const r = await req('/api/reminders', {
        method: 'POST',
        headers: authedHeaders,
        body: JSON.stringify({
          title: `提醒 #${i + 1}`,
          content: `内容 ${i + 1}`,
          category: i % 2 === 0 ? '工作' : '生活',
          tags: [i % 3 === 0 ? '重要' : '日常'],
          scheduledLocal: `2026-12-01T${hour}:${min}`,
          timezone: null,
          isRepeating: false,
          repeatEvery: null,
          repeatUnit: null,
          channelIds: [channelId],
          enabled: true,
        }),
      });
      expect(r.status).toBe(201);
      createdIds.push((await json(r)).data.id as string);
    }

    // Server-side pagination stays within minimal D1 queries
    mockD1.resetQueryCount();
    const page2 = await json(
      await req('/api/reminders?page=2&pageSize=20&sort=desc', { headers: authedHeaders }),
    );
    expect(page2.data.total).toBe(150);
    expect(page2.data.items).toHaveLength(20);
    expect(page2.data.categories).toEqual(['工作', '生活']);
    expect(page2.data.tags).toEqual(['日常', '重要']);
    expect(mockD1.getQueryCount()).toBeLessThanOrEqual(10);

    // Batch disable 150 reminders -> MUST NOT trigger D1 100-param error and stays <= 10 D1 queries!
    mockD1.resetQueryCount();
    const batchDisable = await req('/api/reminders/batch', {
      method: 'POST',
      headers: authedHeaders,
      body: JSON.stringify({ ids: createdIds, action: 'disable' }),
    });
    expect(batchDisable.status).toBe(200);
    expect((await json(batchDisable)).data).toEqual({ updated: 150, skipped: 0 });
    expect(mockD1.getQueryCount()).toBeLessThanOrEqual(10);

    // Export & atomic restore of all 150 reminders -> single batch, never exceeds 100 params!
    const exportRes = await req('/api/backup/export', {
      method: 'POST',
      headers: authedHeaders,
      body: JSON.stringify({ password: 'cf-admin-password' }),
    });
    expect(exportRes.status).toBe(200);
    const snapshot = (await json(exportRes)).data;
    expect(snapshot.reminders).toHaveLength(150);

    mockD1.resetQueryCount();
    const restoreRes = await req('/api/backup/restore', {
      method: 'POST',
      headers: authedHeaders,
      body: JSON.stringify({
        backup: snapshot,
        password: 'cf-admin-password',
        confirmation: 'RESTORE',
      }),
    });
    expect(restoreRes.status).toBe(200);
    expect(mockD1.getQueryCount()).toBeLessThanOrEqual(10);

    // Re-login after restore (session generation rotated)
    const loginRes = await req('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
      body: JSON.stringify({ password: 'cf-admin-password' }),
    });
    expect(loginRes.status).toBe(200);
    const newCookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0]!;

    // 5. Budgeted Cron Tick test: enable 25 reminders and make them due at `now`
    const first25 = createdIds.slice(0, 25);
    const batchEnable = await req('/api/reminders/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: newCookie },
      body: JSON.stringify({ ids: first25, action: 'enable' }),
    });
    expect(batchEnable.status).toBe(200);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ code: 200, message: 'success' }), { status: 200 });
    });

    try {
      const dueNow = Date.UTC(2026, 11, 2, 0, 0, 0);
      mockD1.sqlite.prepare('UPDATE reminders SET next_run_at = ? WHERE enabled = 1').run(dueNow - 10_000);

      // Tick 1: capped at CRON_MAX_DELIVERIES_PER_TICK=10
      const t1 = await scheduler.runTick(dueNow);
      expect(t1.claimedDeliveries).toBe(10);

      // Tick 2: next 10
      const t2 = await scheduler.runTick(dueNow + 60_000);
      expect(t2.claimedDeliveries).toBe(10);

      // Tick 3: remaining 5
      const t3 = await scheduler.runTick(dueNow + 120_000);
      expect(t3.claimedDeliveries).toBe(5);

      // Tick 4: 0 left (idempotent!)
      const t4 = await scheduler.runTick(dueNow + 180_000);
      expect(t4.claimedDeliveries).toBe(0);

      expect(fetchSpy).toHaveBeenCalledTimes(25);

      // Health endpoint should report healthy with heartbeat
      const healthRes = await json(await req('/api/health'));
      expect(healthRes.data.status).toBe('ok');
      expect(healthRes.data.scheduler.lastTickAt).not.toBeNull();
    } finally {
      fetchSpy.mockRestore();
      mockD1.sqlite.close();
    }
  });

  it('keeps sessions valid across stateless Worker invocations when ADMIN_PASSWORD is set without SESSION_SECRET and trusts only CF-Connecting-IP', async () => {
    const mockD1 = createStrictMockD1();
    const seenKeys: string[] = [];
    const rateLimiter: RateLimit = {
      async limit({ key }) {
        seenKeys.push(key);
        return { success: true };
      },
    };
    const env: WorkerEnv = {
      DB: mockD1.d1,
      LOGIN_RATE_LIMITER: rateLimiter,
      ADMIN_PASSWORD: 'env-only-password',
    };

    try {
      // Request 1: fresh Worker instance logs in
      const worker1 = buildWorkerCore(env);
      const loginRes = await worker1.app.request('https://tickbell.example.workers.dev/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '9.9.9.9',
          'CF-Connecting-IP': '1.2.3.4',
        },
        body: JSON.stringify({ password: 'env-only-password' }),
      });
      expect(loginRes.status).toBe(200);
      expect(seenKeys).toEqual(['auth:1.2.3.4']);
      const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0]!;

      // Request 2: brand new Worker instance MUST verify cookie using persisted signing secret
      const worker2 = buildWorkerCore(env);
      const statusRes = await worker2.app.request('https://tickbell.example.workers.dev/api/system/status', {
        headers: { Cookie: cookie },
      });
      expect(statusRes.status).toBe(200);
    } finally {
      mockD1.sqlite.close();
    }
  });

  it('keeps D1_SCHEMA_STATEMENTS in exact sync with migrations/d1/0001_init.sql', () => {
    const stripComments = (sql: string) =>
      sql
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n');
    const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

    const migrationStatements = stripComments(D1_INIT_SQL)
      .split(';')
      .map((s) => normalize(s))
      .filter(Boolean);
    const runtimeStatements = D1_SCHEMA_STATEMENTS.map((s) => normalize(s));

    expect(runtimeStatements).toEqual(migrationStatements);
  });

  it('auto-bootstraps schema on a brand-new empty D1 database for both fetch() and scheduled()', async () => {
    resetD1SchemaCache();
    const mockD1 = createStrictMockD1({ preInitSchema: false });
    const env: WorkerEnv = {
      DB: mockD1.d1,
      LOGIN_RATE_LIMITER: createMockRateLimiter(20),
    };
    const waitUntilPromises: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => {
        waitUntilPromises.push(p);
      },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;

    try {
      // 1. First API request on a completely empty D1 DB succeeds without manual migrations
      const statusRes = await workerEntry.fetch(new Request('https://t.vsz.cc/api/auth/status'), env, ctx);
      expect(statusRes.status).toBe(200);
      const statusBody = (await statusRes.json()) as {
        data: { runtime: string; initialized: boolean; authenticated: boolean };
      };
      expect(statusBody.data).toMatchObject({
        runtime: 'cloudflare',
        initialized: false,
        authenticated: false,
      });

      // 2. Subsequent requests skip schema check entirely (cached per isolate)
      mockD1.resetQueryCount();
      const statusRes2 = await workerEntry.fetch(new Request('https://t.vsz.cc/api/auth/status'), env, ctx);
      expect(statusRes2.status).toBe(200);
      // Only settings lookups from auth.isInitialized + getConfigurationIssue (no sqlite_master / batch)
      expect(mockD1.getQueryCount()).toBeLessThanOrEqual(2);

      // 3. Setup works immediately on the auto-bootstrapped database
      const setupRes = await workerEntry.fetch(
        new Request('https://t.vsz.cc/api/auth/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
          body: JSON.stringify({
            password: 'auto-init-password',
            secret: '0123456789abcdef0123456789abcdef',
            globalTimezone: 'Asia/Shanghai',
          }),
        }),
        env,
        ctx,
      );
      expect(setupRes.status).toBe(200);

      // 4. scheduled() also bootstraps cleanly on a fresh empty D1 DB
      resetD1SchemaCache();
      const freshCronD1 = createStrictMockD1({ preInitSchema: false });
      try {
        const cronEnv: WorkerEnv = {
          DB: freshCronD1.d1,
          LOGIN_RATE_LIMITER: createMockRateLimiter(20),
        };
        workerEntry.scheduled({} as ScheduledController, cronEnv, ctx);
        await Promise.all(waitUntilPromises);

        const healthRes = await workerEntry.fetch(new Request('https://t.vsz.cc/api/health'), cronEnv, ctx);
        expect(healthRes.status).toBe(200);
        const healthBody = (await healthRes.json()) as { data: { status: string; db: string } };
        expect(healthBody.data.status).toBe('ok');
        expect(healthBody.data.db).toBe('ok');
      } finally {
        freshCronD1.sqlite.close();
      }

      // 5. Fallback A: if db.batch() fails during DDL init, falls back to sequential .run()
      resetD1SchemaCache();
      const seqFallbackD1 = createStrictMockD1({ preInitSchema: false });
      try {
        const flakyBatchDb = {
          prepare: seqFallbackD1.d1.prepare.bind(seqFallbackD1.d1),
          batch: async () => {
            throw new Error('D1_ERROR: batch DDL unavailable');
          },
        } as unknown as D1Database;
        const fallbackEnv: WorkerEnv = {
          DB: flakyBatchDb,
          LOGIN_RATE_LIMITER: createMockRateLimiter(20),
        };
        const res = await workerEntry.fetch(new Request('https://t.vsz.cc/api/auth/status'), fallbackEnv, ctx);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { data: { initialized: boolean } };
        expect(body.data.initialized).toBe(false);
      } finally {
        seqFallbackD1.sqlite.close();
      }

      // 6. Fallback B: warm isolate self-heals transparently if tables are dropped externally
      resetD1SchemaCache();
      const selfHealD1 = createStrictMockD1({ preInitSchema: false });
      try {
        const healEnv: WorkerEnv = {
          DB: selfHealD1.d1,
          LOGIN_RATE_LIMITER: createMockRateLimiter(20),
        };
        // Prime warm isolate cache
        const first = await workerEntry.fetch(new Request('https://t.vsz.cc/api/auth/status'), healEnv, ctx);
        expect(first.status).toBe(200);
        // Simulate external wipe of settings table while isolate stays warm
        selfHealD1.sqlite.exec('DROP TABLE settings');
        const healed = await workerEntry.fetch(new Request('https://t.vsz.cc/api/auth/status'), healEnv, ctx);
        expect(healed.status).toBe(200);
        const healedBody = (await healed.json()) as { data: { initialized: boolean } };
        expect(healedBody.data.initialized).toBe(false);
      } finally {
        selfHealD1.sqlite.close();
      }

      // 7. Missing DB binding returns explicit 500 JSON error without poisoning cache
      resetD1SchemaCache();
      const brokenEnv = {
        DB: undefined as unknown as D1Database,
        LOGIN_RATE_LIMITER: createMockRateLimiter(20),
      };
      const brokenRes = await workerEntry.fetch(new Request('https://t.vsz.cc/api/auth/status'), brokenEnv, ctx);
      expect(brokenRes.status).toBe(500);
      const brokenBody = (await brokenRes.json()) as { error: string };
      expect(brokenBody.error).toContain('D1');
    } finally {
      resetD1SchemaCache();
      mockD1.sqlite.close();
    }
  });
});
