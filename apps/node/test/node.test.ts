import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { loadNodeConfig } from '../src/config';
import { createNodeRuntime, type NodeRuntimeHandle } from '../src/create-node-app';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const D1_DIR = path.resolve(__dirname, '../../../migrations/d1');
const SQLITE_DIR = path.resolve(__dirname, '../../../migrations/sqlite');

const tempDirs: string[] = [];
const handles: NodeRuntimeHandle[] = [];

afterEach(async () => {
  while (handles.length) {
    await handles.pop()!.shutdown();
  }
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tickbell-v2-node-'));
  tempDirs.push(dir);
  return dir;
}

describe('TickBell 2.0 Node/Docker runtime & migration parity', () => {
  it('produces identical tables and indexes between migrations/d1 and migrations/sqlite', () => {
    const d1Db = new Database(':memory:');
    d1Db.pragma('foreign_keys = ON');
    for (const file of fs.readdirSync(D1_DIR).filter((f) => f.endsWith('.sql')).sort()) {
      d1Db.exec(fs.readFileSync(path.join(D1_DIR, file), 'utf8'));
    }

    const sqliteDb = new Database(':memory:');
    sqliteDb.pragma('foreign_keys = OFF');
    for (const file of fs.readdirSync(SQLITE_DIR).filter((f) => f.endsWith('.sql')).sort()) {
      sqliteDb.exec(fs.readFileSync(path.join(SQLITE_DIR, file), 'utf8'));
    }
    sqliteDb.pragma('foreign_keys = ON');

    const inspectTables = (db: Database.Database) =>
      (
        db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
          )
          .all() as Array<{ name: string }>
      ).map((r) => r.name);

    const inspectIndexes = (db: Database.Database) =>
      (
        db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
          )
          .all() as Array<{ name: string }>
      ).map((r) => r.name);

    const inspectColumns = (db: Database.Database, table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; notnull: number }>).map(
        (c) => `${c.name}:${c.type}:${c.notnull}`,
      );

    expect(inspectTables(d1Db)).toEqual(inspectTables(sqliteDb));
    expect(inspectIndexes(d1Db)).toEqual(inspectIndexes(sqliteDb));
    for (const table of inspectTables(d1Db)) {
      expect(inspectColumns(d1Db, table)).toEqual(inspectColumns(sqliteDb, table));
    }

    d1Db.close();
    sqliteDb.close();
  });

  it('supports PBKDF2 Web UI setup, Node capabilities, proxies, local auto-backup, and SQLite VACUUM INTO', async () => {
    const tmpDir = makeTempDir();
    const dbPath = path.join(tmpDir, 'tickbell.db');
    const backupDir = path.join(tmpDir, 'backups');

    const config = loadNodeConfig(
      {
        NODE_ENV: 'test',
        DEMO_MODE: 'false',
        DB_PATH: dbPath,
        BACKUP_DIR: backupDir,
        SCHEDULER_ENABLED: 'false',
        COOKIE_SECURE: 'false',
        ALLOW_PRIVATE_URLS: 'true',
      },
      tmpDir,
    );

    const runtime = createNodeRuntime({
      config,
      http: {
        request: async () => ({ ok: true, status: 204, text: '' }),
        post: async () => ({ ok: true, status: 200, text: '{"code":200}' }),
      },
    });
    handles.push(runtime);

    const app = runtime.bundle.app;
    const req = (p: string, init?: RequestInit) => app.request(`http://localhost:3000${p}`, init);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = async (res: Response): Promise<any> => res.json();

    // First-run setup stores PBKDF2-SHA256 password hash & session cookie
    const setupRes = await req('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        password: 'node-admin-password',
        secret: '0123456789abcdef0123456789abcdef',
        globalTimezone: 'Asia/Shanghai',
      }),
    });
    expect(setupRes.status).toBe(200);
    const cookie = (setupRes.headers.get('set-cookie') ?? '').split(';')[0]!;
    const storedHashRow = await runtime.db.first<{ value: string }>({
      sql: `SELECT value FROM settings WHERE key = 'auth_password_hash'`,
    });
    expect(storedHashRow?.value.startsWith('pbkdf2-sha256$')).toBe(true);

    const headers = { 'Content-Type': 'application/json', Cookie: cookie };

    // Verify Node capabilities
    const statusRes = await json(await req('/api/system/status', { headers }));
    expect(statusRes.data.runtime).toBe('node');
    expect(statusRes.data.capabilities.proxies).toBe(true);
    expect(statusRes.data.capabilities.diskAutoBackup).toBe(true);
    expect(statusRes.data.capabilities.sqliteVacuumBackup).toBe(true);

    // Proxies CRUD + test
    const proxyRes = await req('/api/proxies', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: '本地代理',
        protocol: 'socks5',
        host: '127.0.0.1',
        port: 7890,
        enabled: true,
      }),
    });
    expect(proxyRes.status).toBe(201);
    const proxyId = (await json(proxyRes)).data.id as string;

    const proxyTest = await json(await req(`/api/proxies/${proxyId}/test`, { method: 'POST', headers }));
    expect(proxyTest.data.ok).toBe(true);

    // Disk auto-backup run + list + read + SQLite VACUUM INTO
    const autoRun = await req('/api/backup/auto/run', { method: 'POST', headers });
    expect(autoRun.status).toBe(200);
    const autoFileName = (await json(autoRun)).data.file.name as string;
    expect(autoFileName).toMatch(/^tickbell-auto-\d{8}-\d{6}\.json$/);

    const readBack = await req(`/api/backup/auto/files/${autoFileName}`, { headers });
    expect(readBack.status).toBe(200);

    const sqliteBackupFile = await runtime.runSqliteBackup();
    expect(sqliteBackupFile).toMatch(/^tickbell-\d{8}-\d{6}\.db$/);
    expect(fs.existsSync(path.join(backupDir, sqliteBackupFile!))).toBe(true);
  });

  it('ignores spoofed CF-Connecting-IP and X-Forwarded-Proto headers when TRUST_PROXY is false', async () => {
    const dir = makeTempDir();
    const config = loadNodeConfig(
      {
        NODE_ENV: 'test',
        DEMO_MODE: 'false',
        DB_PATH: path.join(dir, 'trust.db'),
        ADMIN_PASSWORD: 'direct-node-password',
        TRUST_PROXY: 'false',
        SCHEDULER_ENABLED: 'false',
      },
      dir,
    );
    const runtime = createNodeRuntime({ config });
    handles.push(runtime);

    // 1. Spoofing X-Forwarded-Proto: https over HTTP must NOT mark session cookie Secure
    const okLogin = await runtime.bundle.app.request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-Proto': 'https',
      },
      body: JSON.stringify({ password: 'direct-node-password' }),
    });
    expect(okLogin.status).toBe(200);
    expect(okLogin.headers.get('set-cookie') ?? '').not.toContain('Secure');

    // 2. Spoofing CF-Connecting-IP or X-Forwarded-For must NOT bypass 5/min rate limit (1 already used above)
    for (let i = 0; i < 4; i += 1) {
      const res = await runtime.bundle.app.request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Connecting-IP': `10.0.0.${i + 1}`,
          'X-Forwarded-For': `10.0.1.${i + 1}`,
        },
        body: JSON.stringify({ password: 'wrong-password' }),
      });
      expect(res.status).toBe(401);
    }
    const blocked = await runtime.bundle.app.request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '10.0.0.99',
      },
      body: JSON.stringify({ password: 'wrong-password' }),
    });
    expect(blocked.status).toBe(429);
  });

  it('enforces preview demo mode: preset login, seeded data, disabled scheduler, high-risk 403s, quotas, test-only rate limit, and reset', async () => {
    const dir = makeTempDir();
    const config = loadNodeConfig(
      {
        NODE_ENV: 'test',
        DB_PATH: path.join(dir, 'demo.db'),
        DEMO_MAX_REMINDERS: '8',
        DEMO_MAX_CHANNELS: '6',
        DEMO_TEST_RATE_LIMIT: '2',
        COOKIE_SECURE: 'false',
      },
      dir,
    );
    expect(config.demoMode).toBe(true);
    expect(config.schedulerEnabled).toBe(false);
    expect(config.allowPrivateUrls).toBe(false);
    expect(config.demoPassword).toBe('tickbell123');
    expect(config.demoResetCron).toBe('0 3 * * *');
    expect(config.demoResetTimezone).toBe('Asia/Shanghai');

    const runtime = createNodeRuntime({
      config,
      http: {
        request: async () => ({ ok: true, status: 200, text: '{"ok":true}' }),
        post: async () => ({ ok: true, status: 200, text: '{"code":200,"message":"success"}' }),
      },
    });
    handles.push(runtime);
    await runtime.startBackgroundTasks();

    const app = runtime.bundle.app;
    const req = (p: string, init?: RequestInit) => app.request(`http://localhost:3000${p}`, init);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = async (res: Response): Promise<any> => res.json();

    // 1. Health OK with scheduler disabled & auth status exposes demo hint
    const health = await json(await req('/api/health'));
    expect(health.data.status).toBe('ok');
    expect(health.data.scheduler.enabled).toBe(false);

    const authStatus = await json(await req('/api/auth/status'));
    expect(authStatus.data.initialized).toBe(true);
    expect(authStatus.data.demo.enabled).toBe(true);
    expect(authStatus.data.demo.passwordHint).toBe('tickbell123');

    // 2. Login with preset demo password
    const loginRes = await req('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'tickbell123' }),
    });
    expect(loginRes.status).toBe(200);
    const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0]!;
    const headers = { 'Content-Type': 'application/json', Cookie: cookie };

    // 3. Seeded channels (5), reminders (7), and deliveries (7) are preloaded
    const sysStatus = await json(await req('/api/system/status', { headers }));
    expect(sysStatus.data.demo.enabled).toBe(true);
    expect(sysStatus.data.counts.channels).toBe(5);
    expect(sysStatus.data.counts.reminders).toBe(7);
    expect(sysStatus.data.capabilities.proxies).toBe(false);
    expect(sysStatus.data.capabilities.diskAutoBackup).toBe(false);

    const deliveriesPage = await json(await req('/api/deliveries?page=1&pageSize=20', { headers }));
    expect(deliveriesPage.data.total).toBe(7);

    // 4. High-risk operations strictly return 403
    expect((await req('/api/auth/setup', { method: 'POST', headers, body: '{}' })).status).toBe(403);
    expect(
      (
        await req('/api/auth/change-password', {
          method: 'POST',
          headers,
          body: JSON.stringify({ currentPassword: 'tickbell123', newPassword: 'newpassword' }),
        })
      ).status,
    ).toBe(403);
    expect((await req('/api/proxies', { headers })).status).toBe(403);
    expect((await req('/api/backup/export', { method: 'POST', headers, body: '{}' })).status).toBe(403);
    expect((await req('/api/backup/restore', { method: 'POST', headers, body: '{}' })).status).toBe(403);
    expect((await req('/api/backup/auto', { headers })).status).toBe(403);
    expect(
      (await req('/api/deliveries/33333333-3333-4333-8333-333333333306/retry', { method: 'POST', headers })).status,
    ).toBe(403);

    // 5. Private URL SSRF blocked in demo mode
    const privCh = await req('/api/channels', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: '内网探测',
        type: 'bark',
        enabled: true,
        config: { serverUrl: 'http://127.0.0.1:8080', deviceKey: 'abc' },
      }),
    });
    expect(privCh.status).toBe(400);

    // 6. Channel quota enforced (5 seeded, max 6 -> 1st succeeds, 2nd fails)
    const chOk = await req('/api/channels', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: '第 6 个渠道',
        type: 'bark',
        enabled: true,
        config: { serverUrl: 'https://api.day.app', deviceKey: 'demo-key-6' },
      }),
    });
    expect(chOk.status).toBe(201);
    const createdChannelId = (await json(chOk)).data.id as string;

    const chOver = await req('/api/channels', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: '超限渠道',
        type: 'bark',
        enabled: true,
        config: { serverUrl: 'https://api.day.app', deviceKey: 'demo-key-7' },
      }),
    });
    expect(chOver.status).toBe(400);

    // 7. Reminder quota enforced (7 seeded, max 8 -> 1st succeeds, 2nd fails)
    const remPayload = {
      title: '第 8 条提醒',
      content: '测试内容',
      scheduledLocal: '2026-12-20T10:00',
      timezone: null,
      isRepeating: false,
      repeatEvery: null,
      repeatUnit: null,
      channelIds: [createdChannelId],
      enabled: true,
    };
    expect((await req('/api/reminders', { method: 'POST', headers, body: JSON.stringify(remPayload) })).status).toBe(201);
    expect(
      (await req('/api/reminders', { method: 'POST', headers, body: JSON.stringify({ ...remPayload, title: '超限' }) })).status,
    ).toBe(400);

    // 8. Manual test send works AND enforces test rate limit (limit=2 -> 3rd returns 429)
    expect((await req(`/api/channels/${createdChannelId}/test`, { method: 'POST', headers })).status).toBe(200);
    expect((await req('/api/reminders/test', { method: 'POST', headers, body: JSON.stringify(remPayload) })).status).toBe(200);
    expect((await req(`/api/channels/${createdChannelId}/test`, { method: 'POST', headers })).status).toBe(429);

    // 9. Daily reset restores exact seeded counts (5 channels, 7 reminders) and keeps login working
    await runtime.resetDemoData();
    const afterReset = await json(await req('/api/system/status', { headers }));
    expect(afterReset.data.counts.channels).toBe(5);
    expect(afterReset.data.counts.reminders).toBe(7);
  });
});
