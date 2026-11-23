import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Database from 'better-sqlite3';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { APP_CONFIG, loadAppConfig } from '../src/config/app-config';
import { BackupService } from '../src/modules/backup/backup.service';
import { DatabaseService } from '../src/modules/database/database.service';
import {
  CHANNEL_PROVIDERS,
  type ChannelProvider,
  NOTIFICATION_HTTP_POST,
  type NotificationResult,
} from '../src/modules/notifications/channel-provider.interface';
import { BarkProvider } from '../src/modules/notifications/providers/bark.provider';
import { DingTalkProvider } from '../src/modules/notifications/providers/dingtalk.provider';
import { FeishuProvider } from '../src/modules/notifications/providers/feishu.provider';
import { ServerChanProvider } from '../src/modules/notifications/providers/serverchan.provider';
import { TelegramProvider } from '../src/modules/notifications/providers/telegram.provider';
import { WebhookProvider } from '../src/modules/notifications/providers/webhook.provider';
import { WeComProvider } from '../src/modules/notifications/providers/wecom.provider';
import type { HttpPostFn } from '../src/modules/notifications/http/pinned-fetch';
import { SchedulerService } from '../src/modules/scheduler/scheduler.service';

interface TestHarness {
  app: INestApplication;
  httpPost: ReturnType<typeof vi.fn<HttpPostFn>>;
  scheduler: SchedulerService;
  database: DatabaseService;
  loginCookie: () => Promise<string>;
}

const appsToClose: INestApplication[] = [];

afterEach(async () => {
  while (appsToClose.length) {
    const app = appsToClose.pop();
    if (app) await app.close();
  }
});

async function createTestApp(options?: {
  dbPath?: string;
  maxReminders?: number;
  missedGraceMinutes?: number;
  extraProviders?: ChannelProvider[];
  uninitialized?: boolean;
}): Promise<TestHarness> {
  const httpPost = vi.fn<HttpPostFn>().mockResolvedValue({
    ok: true,
    status: 200,
    text: JSON.stringify({ code: 200, message: 'success' }),
  });

  const config = loadAppConfig({
    NODE_ENV: 'test',
    ADMIN_PASSWORD: options?.uninitialized ? '' : 'test-admin-password',
    SESSION_SECRET: options?.uninitialized ? '' : 'test-session-secret-0123456789',
    DB_PATH: options?.dbPath ?? ':memory:',
    SCHEDULER_ENABLED: 'false',
    MAX_REMINDERS: String(options?.maxReminders ?? 500),
    MISSED_GRACE_MINUTES: String(options?.missedGraceMinutes ?? 60),
    COOKIE_SECURE: 'false',
    LOG_LEVEL: 'silent',
  });

  const builder = Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(APP_CONFIG)
    .useValue(config)
    .overrideProvider(NOTIFICATION_HTTP_POST)
    .useValue(httpPost)
    .overrideProvider(BarkProvider)
    .useFactory({ factory: () => new BarkProvider(config, httpPost) })
    .overrideProvider(TelegramProvider)
    .useFactory({ factory: () => new TelegramProvider(config, httpPost) })
    .overrideProvider(WeComProvider)
    .useFactory({ factory: () => new WeComProvider(config, httpPost) })
    .overrideProvider(DingTalkProvider)
    .useFactory({ factory: () => new DingTalkProvider(config, httpPost) })
    .overrideProvider(FeishuProvider)
    .useFactory({ factory: () => new FeishuProvider(config, httpPost) })
    .overrideProvider(ServerChanProvider)
    .useFactory({ factory: () => new ServerChanProvider(config, httpPost) })
    .overrideProvider(WebhookProvider)
    .useFactory({ factory: () => new WebhookProvider(config, httpPost) });

  if (options?.extraProviders?.length) {
    builder.overrideProvider(CHANNEL_PROVIDERS).useFactory({
      inject: [
        BarkProvider,
        TelegramProvider,
        WeComProvider,
        DingTalkProvider,
        FeishuProvider,
        ServerChanProvider,
        WebhookProvider,
      ],
      factory: (
        bark: BarkProvider,
        telegram: TelegramProvider,
        wecom: WeComProvider,
        dingtalk: DingTalkProvider,
        feishu: FeishuProvider,
        serverchan: ServerChanProvider,
        webhook: WebhookProvider,
      ) => [bark, telegram, wecom, dingtalk, feishu, serverchan, webhook, ...options.extraProviders!],
    });
  }

  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ bodyParser: false, logger: false });
  configureApp(app);
  await app.init();
  appsToClose.push(app);

  const loginCookie = async (): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ password: 'test-admin-password' })
      .expect(200);
    const setCookie = res.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie[0]! : String(setCookie);
    return raw.split(';')[0]!;
  };

  return {
    app,
    httpPost,
    scheduler: app.get(SchedulerService),
    database: app.get(DatabaseService),
    loginCookie,
  };
}

describe('TickBell end-to-end integration', () => {
  it('handles auth status, login, protected routes, logout, and rate limit (429)', async () => {
    const { app } = await createTestApp();
    const server = app.getHttpServer();

    const health = await request(server).get('/api/health').expect(200);
    expect(health.body.data.status).toBe('ok');

    const statusBefore = await request(server).get('/api/auth/status').expect(200);
    expect(statusBefore.body.data).toEqual({
      initialized: true,
      configured: true,
      authenticated: false,
      configurationIssue: null,
    });

    await request(server).get('/api/reminders').expect(401);

    // Wrong passwords until throttler blocks on 6th attempt
    for (let i = 0; i < 5; i += 1) {
      await request(server).post('/api/auth/login').send({ password: 'wrong' }).expect(401);
    }
    const throttled = await request(server).post('/api/auth/login').send({ password: 'wrong' }).expect(429);
    expect(throttled.headers['retry-after']).toBe('60');
    expect(throttled.body.error).toBeTruthy();
  });

  it('supports Bark channel CRUD, reminder CRUD/batch/enable rules, and global timezone updates', async () => {
    const { app, loginCookie } = await createTestApp({ maxReminders: 3 });
    const server = app.getHttpServer();
    const cookie = await loginCookie();

    // Channel types exposes all 7 built-in channels in order
    const typesRes = await request(server).get('/api/channels/types').set('Cookie', cookie).expect(200);
    expect(typesRes.body.data.map((t: { type: string }) => t.type)).toEqual([
      'bark',
      'telegram',
      'wecom',
      'dingtalk',
      'feishu',
      'serverchan',
      'webhook',
    ]);

    // Unsupported type cannot be created
    await request(server)
      .post('/api/channels')
      .set('Cookie', cookie)
      .send({ name: 'Unknown', type: 'legacy-sms', enabled: true, config: {} })
      .expect(400);

    // Create Bark channel
    const chRes = await request(server)
      .post('/api/channels')
      .set('Cookie', cookie)
      .send({
        name: '我的 iPhone',
        type: 'bark',
        enabled: true,
        config: { serverUrl: 'https://api.day.app', deviceKey: 'my-secret-key', level: 'timeSensitive' },
      })
      .expect(201);
    const channelId = chRes.body.data.id as string;
    expect(chRes.body.data.secretsSet).toEqual([]);
    expect(chRes.body.data.config.deviceKey).toBe('my-secret-key');
    expect(chRes.body.data.configured).toBe(true);

    // Test channel returns 200 with ok=true
    const chTest = await request(server).post(`/api/channels/${channelId}/test`).set('Cookie', cookie).expect(200);
    expect(chTest.body.data.ok).toBe(true);

    // Update global timezone
    await request(server)
      .put('/api/settings')
      .set('Cookie', cookie)
      .send({ globalTimezone: 'Asia/Shanghai' })
      .expect(200);

    // Create repeating reminder in past (paused) + future single reminder
    const r1 = await request(server)
      .post('/api/reminders')
      .set('Cookie', cookie)
      .send({
        title: '每日晨会',
        contentHtml: '<p>准时参加</p>',
        category: '工作',
        tags: ['例会'],
        scheduledLocal: '2026-01-01T09:00',
        timezone: null,
        isRepeating: true,
        repeatEvery: 1,
        repeatUnit: 'day',
        channelIds: [channelId],
        enabled: false,
      })
      .expect(201);
    const r1Id = r1.body.data.id as string;

    // Enabling a past repeating reminder jumps nextRunAt to the future without backfilling
    const enabledR1 = await request(server)
      .post(`/api/reminders/${r1Id}/enable`)
      .set('Cookie', cookie)
      .expect(200);
    expect(enabledR1.body.data.enabled).toBe(true);
    expect(Date.parse(enabledR1.body.data.nextRunAt)).toBeGreaterThan(Date.now());

    // Changing global timezone preserves wall-clock time (09:00) for inherited reminder
    await request(server)
      .put('/api/settings')
      .set('Cookie', cookie)
      .send({ globalTimezone: 'Asia/Tokyo' })
      .expect(200);
    const afterTz = await request(server).get(`/api/reminders/${r1Id}`).set('Cookie', cookie).expect(200);
    expect(afterTz.body.data.timezone).toBe('Asia/Tokyo');
    expect(afterTz.body.data.scheduledLocal).toBe('2026-01-01T09:00');
    expect(afterTz.body.data.nextRunLocal.endsWith('T09:00')).toBe(true);

    // Single reminder in past cannot be enabled
    const r2 = await request(server)
      .post('/api/reminders')
      .set('Cookie', cookie)
      .send({
        title: '过期单次',
        scheduledLocal: '2020-01-01T08:00',
        timezone: 'UTC',
        isRepeating: false,
        repeatEvery: null,
        repeatUnit: null,
        channelIds: [channelId],
        enabled: false,
      })
      .expect(201);
    await request(server).post(`/api/reminders/${r2.body.data.id}/enable`).set('Cookie', cookie).expect(400);

    // Deleting a channel referenced by reminders returns 409
    await request(server).delete(`/api/channels/${channelId}`).set('Cookie', cookie).expect(409);

    // Batch disable + delete
    const batchDel = await request(server)
      .post('/api/reminders/batch')
      .set('Cookie', cookie)
      .send({ ids: [r2.body.data.id], action: 'delete' })
      .expect(200);
    expect(batchDel.body.data).toEqual({ updated: 1, skipped: 0 });

    // Test reminder without saving
    const testRem = await request(server)
      .post('/api/reminders/test')
      .set('Cookie', cookie)
      .send({
        title: '草稿测试',
        content: '不落库',
        scheduledLocal: '2026-12-01T09:00',
        timezone: null,
        isRepeating: false,
        repeatEvery: null,
        repeatUnit: null,
        channelIds: [channelId],
      })
      .expect(200);
    expect(testRem.body.data).toEqual([
      { channelId, channelName: '我的 iPhone', ok: true, error: null },
    ]);

    // System status & unknown API 404
    const sysStatus = await request(server).get('/api/system/status').set('Cookie', cookie).expect(200);
    expect(sysStatus.body.data.counts.channels).toBe(1);
    expect(sysStatus.body.data.limits.maxReminders).toBe(3);

    const notFoundApi = await request(server).get('/api/unknown-route').set('Cookie', cookie).expect(404);
    expect(notFoundApi.body.error).toBe('接口不存在');
  });

  it('proves channel extension point: a fake provider works end-to-end without core/schema changes', async () => {
    const sentMessages: Array<{ title: string; target: string }> = [];
    const fakeProvider: ChannelProvider<{ target: string }> = {
      type: 'mock-sms',
      meta: { type: 'mock-sms', name: 'Mock SMS', description: 'Test provider', icon: 'send', order: 2 },
      fields: [{ key: 'target', label: 'Phone', control: 'text', required: true, secret: false }],
      configSchema: z.strictObject({ target: z.string().min(1) }),
      mergeConfig: (raw) => {
        const obj = raw as { target?: string };
        return obj.target ? { target: obj.target } : null;
      },
      maskConfig: (cfg) => ({ config: cfg, secretsSet: [], configured: Boolean(cfg?.target), summary: [] }),
      isConfigured: (cfg) => Boolean(cfg?.target),
      send: async (msg, cfg): Promise<NotificationResult> => {
        sentMessages.push({ title: msg.title, target: cfg.target });
        return { ok: true, httpStatus: 200, responseSummary: 'mocked', error: null };
      },
    };

    const { app, scheduler, loginCookie } = await createTestApp({ extraProviders: [fakeProvider] });
    const server = app.getHttpServer();
    const cookie = await loginCookie();

    const ch = await request(server)
      .post('/api/channels')
      .set('Cookie', cookie)
      .send({ name: '短信通道', type: 'mock-sms', enabled: true, config: { target: '+8613800138000' } })
      .expect(201);

    const rem = await request(server)
      .post('/api/reminders')
      .set('Cookie', cookie)
      .send({
        title: '验证码测试',
        scheduledLocal: '2026-11-23T10:00',
        timezone: 'UTC',
        isRepeating: false,
        repeatEvery: null,
        repeatUnit: null,
        channelIds: [ch.body.data.id],
      })
      .expect(201);

    const dueAt = Date.parse(rem.body.data.nextRunAt);
    await scheduler.runTick(dueAt + 5_000);
    // Second tick must be idempotent (no duplicate)
    await scheduler.runTick(dueAt + 20_000);

    expect(sentMessages).toEqual([{ title: '验证码测试', target: '+8613800138000' }]);
    const deliveries = await request(server).get('/api/deliveries').set('Cookie', cookie).expect(200);
    expect(deliveries.body.data.total).toBe(1);
    expect(deliveries.body.data.items[0].status).toBe('sent');
    expect(deliveries.body.data.items[0].channelType).toBe('mock-sms');
  });

  it('enforces grace window skip, retry backoff (1/5/15m), manual retry reusing eventId, and 409 on non-failed retry', async () => {
    const { app, httpPost, scheduler, loginCookie } = await createTestApp({ missedGraceMinutes: 30 });
    const server = app.getHttpServer();
    const cookie = await loginCookie();

    const ch = await request(server)
      .post('/api/channels')
      .set('Cookie', cookie)
      .send({
        name: 'Bark 主通道',
        type: 'bark',
        enabled: true,
        config: { serverUrl: 'https://api.day.app', deviceKey: 'dk-retry' },
      })
      .expect(201);
    const channelId = ch.body.data.id as string;

    // 1. Reminder missed beyond 30-min grace window -> skipped, no HTTP call
    const missedRem = await request(server)
      .post('/api/reminders')
      .set('Cookie', cookie)
      .send({
        title: '超期提醒',
        scheduledLocal: '2026-11-23T08:00',
        timezone: 'UTC',
        isRepeating: false,
        repeatEvery: null,
        repeatUnit: null,
        channelIds: [channelId],
      })
      .expect(201);
    const missedDue = Date.parse(missedRem.body.data.nextRunAt);
    await scheduler.runTick(missedDue + 45 * 60_000);
    expect(httpPost).not.toHaveBeenCalled();

    const skippedLogs = await request(server)
      .get(`/api/deliveries?reminderId=${missedRem.body.data.id}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(skippedLogs.body.data.items[0].status).toBe('skipped');
    // Cannot manually retry a skipped delivery -> 409
    await request(server)
      .post(`/api/deliveries/${skippedLogs.body.data.items[0].id}/retry`)
      .set('Cookie', cookie)
      .expect(409);

    // 2. Retryable 503 fails 4 times (1 initial + 3 retries at 1m, 5m, 15m) -> becomes failed
    httpPost.mockResolvedValue({ ok: false, status: 503, text: 'busy' });
    const retryRem = await request(server)
      .post('/api/reminders')
      .set('Cookie', cookie)
      .send({
        title: '重试测试',
        scheduledLocal: '2026-11-23T12:00',
        timezone: 'UTC',
        isRepeating: false,
        repeatEvery: null,
        repeatUnit: null,
        channelIds: [channelId],
      })
      .expect(201);
    const t0 = Date.parse(retryRem.body.data.nextRunAt);

    // Initial attempt -> retrying (+1m)
    await scheduler.runTick(t0 + 1_000);
    let page = await request(server).get(`/api/deliveries?reminderId=${retryRem.body.data.id}`).set('Cookie', cookie);
    let d = page.body.data.items[0];
    expect(d.status).toBe('retrying');
    expect(d.attempts).toBe(1);
    const originalEventId = d.eventId;

    // Retry #1 (+1m) -> retrying (+5m)
    await scheduler.runTick(Date.parse(d.nextRetryAt));
    page = await request(server).get(`/api/deliveries?reminderId=${retryRem.body.data.id}`).set('Cookie', cookie);
    d = page.body.data.items[0];
    expect(d.status).toBe('retrying');
    expect(d.attempts).toBe(2);

    // Retry #2 (+5m) -> retrying (+15m)
    await scheduler.runTick(Date.parse(d.nextRetryAt));
    page = await request(server).get(`/api/deliveries?reminderId=${retryRem.body.data.id}`).set('Cookie', cookie);
    d = page.body.data.items[0];
    expect(d.status).toBe('retrying');
    expect(d.attempts).toBe(3);

    // Retry #3 (+15m) -> failed (exhausted)
    await scheduler.runTick(Date.parse(d.nextRetryAt));
    page = await request(server).get(`/api/deliveries?reminderId=${retryRem.body.data.id}`).set('Cookie', cookie);
    d = page.body.data.items[0];
    expect(d.status).toBe('failed');
    expect(d.attempts).toBe(4);
    expect(d.nextRetryAt).toBeNull();

    // Manual retry succeeds and preserves eventId
    httpPost.mockResolvedValueOnce({ ok: true, status: 200, text: JSON.stringify({ code: 200, message: 'ok' }) });
    const retried = await request(server).post(`/api/deliveries/${d.id}/retry`).set('Cookie', cookie).expect(200);
    expect(retried.body.data.status).toBe('sent');
    expect(retried.body.data.eventId).toBe(originalEventId);
    expect(retried.body.data.attempts).toBe(5);
  });

  it('imports Tips v1 full backup (keeping telegram disabled/unsupported) and round-trips v2 backup', async () => {
    const { app, loginCookie } = await createTestApp();
    const server = app.getHttpServer();
    const cookie = await loginCookie();

    const now = Date.UTC(2026, 10, 23, 2, 0, 0);
    const tipsV1Backup = {
      format: 'tips-full-backup',
      version: 1,
      exportedAt: new Date(now).toISOString(),
      settings: [{ key: 'global_timezone', value: 'Asia/Shanghai', updated_at: now }],
      channels: [
        {
          id: 'ch-bark-1',
          name: 'iPhone Bark',
          type: 'bark',
          enabled: 1,
          config: JSON.stringify({ serverUrl: 'https://api.day.app', deviceKey: 'bark-key' }),
          legacy_encrypted_config: null,
          created_at: now,
          updated_at: now,
        },
        {
          id: 'ch-unknown-1',
          name: '旧自定义短信',
          type: 'legacy-sms',
          enabled: 1,
          config: JSON.stringify({ endpoint: 'https://sms.example.com' }),
          legacy_encrypted_config: null,
          created_at: now,
          updated_at: now,
        },
      ],
      reminders: [
        {
          id: 'rem-unknown-only',
          title: '仅绑定未支持渠道的提醒',
          content: '内容',
          content_html: '<p>内容</p>',
          category: '迁移',
          tags: '["旧数据"]',
          timezone: null,
          starts_at: now + 3_600_000,
          next_run_at: now + 3_600_000,
          is_repeating: 0,
          repeat_every: null,
          repeat_unit: null,
          enabled: 1,
          completed: 0,
          deleted_at: null,
          created_at: now,
          updated_at: now,
          schedule_version: 1,
        },
      ],
      reminderChannels: [{ reminder_id: 'rem-unknown-only', channel_id: 'ch-unknown-1' }],
      deliveries: [
        {
          id: 'del-1',
          event_id: 'evt-old-1',
          reminder_id: 'rem-unknown-only',
          scheduled_at: now - 60_000,
          channel_id: 'ch-unknown-1',
          status: 'pending',
          attempts: 0,
          http_status: null,
          error: null,
          response_summary: null,
          sent_at: null,
          created_at: now - 60_000,
          updated_at: now - 60_000,
        },
      ],
      receipts: [{ reminder_id: 'rem-unknown-only', scheduled_at: now - 60_000, channel_id: 'ch-unknown-1' }],
    };

    // Preview identifies unsupported channel and reminder without usable channel
    const preview = await request(server)
      .post('/api/backup/preview')
      .set('Cookie', cookie)
      .send({ backup: tipsV1Backup })
      .expect(200);
    expect(preview.body.data.sourceVersion).toBe(1);
    expect(preview.body.data.unsupportedChannels).toBe(1);
    expect(preview.body.data.remindersWithoutUsableChannel).toEqual([
      { id: 'rem-unknown-only', title: '仅绑定未支持渠道的提醒' },
    ]);

    // Restore invalidates old session cookie
    await request(server)
      .post('/api/backup/restore')
      .set('Cookie', cookie)
      .send({ backup: tipsV1Backup, password: 'test-admin-password', confirmation: 'RESTORE' })
      .expect(200);
    await request(server).get('/api/reminders').set('Cookie', cookie).expect(401);

    // Login again and inspect restored data
    const newCookie = await loginCookie();
    const channels = await request(server).get('/api/channels').set('Cookie', newCookie).expect(200);
    const unknown = channels.body.data.find((c: { id: string }) => c.id === 'ch-unknown-1');
    expect(unknown.supported).toBe(false);
    expect(unknown.enabled).toBe(false);
    expect(unknown.config).toBeNull();

    // Unsupported channel can be renamed while disabled, but cannot be enabled
    await request(server)
      .put('/api/channels/ch-unknown-1')
      .set('Cookie', newCookie)
      .send({ name: '旧短信（归档）', enabled: false })
      .expect(200);
    await request(server)
      .put('/api/channels/ch-unknown-1')
      .set('Cookie', newCookie)
      .send({ name: '旧短信', enabled: true })
      .expect(400);

    // All restored reminders are paused, and pending delivery became failed
    const reminders = await request(server).get('/api/reminders').set('Cookie', newCookie).expect(200);
    expect(reminders.body.data[0].enabled).toBe(false);
    const deliveries = await request(server).get('/api/deliveries').set('Cookie', newCookie).expect(200);
    expect(deliveries.body.data.items[0].status).toBe('failed');

    // Export v2 and verify slim format (reminders + channels + reminderChannels + settings only; no deliveries/receipts/auth)
    const exported = await request(server)
      .post('/api/backup/export')
      .set('Cookie', newCookie)
      .send({ password: 'test-admin-password' })
      .expect(200);
    expect(exported.body.data.format).toBe('tickbell-full-backup');
    expect(exported.body.data.version).toBe(2);
    expect(exported.body.data.channels).toHaveLength(2);
    expect(exported.body.data.deliveries).toBeUndefined();
    expect(exported.body.data.receipts).toBeUndefined();
    const exportedKeys = exported.body.data.settings.map((s: { key: string }) => s.key);
    expect(exportedKeys).not.toContain('auth_password_hash');
    expect(exportedKeys).not.toContain('auth_session_secret');
    expect(exportedKeys).not.toContain('session_generation');

    // Slim v2 export round-trips cleanly through preview & restore
    const slimPreview = await request(server)
      .post('/api/backup/preview')
      .set('Cookie', newCookie)
      .send({ backup: exported.body.data })
      .expect(200);
    expect(slimPreview.body.data.deliveries).toBe(0);
    expect(slimPreview.body.data.channels).toBe(2);
    await request(server)
      .post('/api/backup/restore')
      .set('Cookie', newCookie)
      .send({ backup: exported.body.data, password: 'test-admin-password', confirmation: 'RESTORE' })
      .expect(200);
  });

  it('supports zero-env first-run setup, change-password, self-hosted private Bark URL, and preserves auth across restore', async () => {
    const { app } = await createTestApp({ uninitialized: true });
    const server = app.getHttpServer();

    // Before setup: initialized=false, protected APIs return 503
    const status0 = await request(server).get('/api/auth/status').expect(200);
    expect(status0.body.data.initialized).toBe(false);
    await request(server).get('/api/reminders').expect(503);

    // First-run setup sets password, secret, and initial timezone in SQLite, and logs user in
    const setupRes = await request(server)
      .post('/api/auth/setup')
      .send({
        password: 'first-run-password',
        secret: 'my-first-run-secret-key-0123456789',
        globalTimezone: 'Asia/Shanghai',
      })
      .expect(200);
    expect(setupRes.body.data.authenticated).toBe(true);
    const rawSetCookie = setupRes.headers['set-cookie'];
    const cookie1 = (Array.isArray(rawSetCookie) ? rawSetCookie[0]! : String(rawSetCookie)).split(';')[0]!;

    // Second setup attempt must be rejected with 409
    await request(server)
      .post('/api/auth/setup')
      .send({ password: 'other-password', secret: 'another-secret-key-0123456789' })
      .expect(409);

    // Global timezone was applied
    const tzRes = await request(server).get('/api/settings').set('Cookie', cookie1).expect(200);
    expect(tzRes.body.data.globalTimezone).toBe('Asia/Shanghai');

    // Self-hosted private LAN Bark URL works out of the box
    const chRes = await request(server)
      .post('/api/channels')
      .set('Cookie', cookie1)
      .send({
        name: '自建 Bark',
        type: 'bark',
        enabled: true,
        config: {
          serverUrl: 'http://192.168.1.10:8080',
          deviceKey: 'lan-bark-key',
          group: '家庭',
          level: 'timeSensitive',
          isArchive: true,
        },
      })
      .expect(201);
    expect(chRes.body.data.config.serverUrl).toBe('http://192.168.1.10:8080');
    expect(chRes.body.data.config.group).toBe('家庭');

    // Change password invalidates old cookie and issues fresh cookie
    const chPwd = await request(server)
      .post('/api/auth/change-password')
      .set('Cookie', cookie1)
      .send({ currentPassword: 'first-run-password', newPassword: 'updated-password-999' })
      .expect(200);
    const rawCookie2 = chPwd.headers['set-cookie'];
    const cookie2 = (Array.isArray(rawCookie2) ? rawCookie2[0]! : String(rawCookie2)).split(';')[0]!;
    await request(server).get('/api/reminders').set('Cookie', cookie1).expect(401);
    await request(server).get('/api/reminders').set('Cookie', cookie2).expect(200);

    // Export and restore must preserve DB password & secret
    const exported = await request(server)
      .post('/api/backup/export')
      .set('Cookie', cookie2)
      .send({ password: 'updated-password-999' })
      .expect(200);
    await request(server)
      .post('/api/backup/restore')
      .set('Cookie', cookie2)
      .send({ backup: exported.body.data, password: 'updated-password-999', confirmation: 'RESTORE' })
      .expect(200);

    // After restore, system is still initialized and accepts the same password!
    const statusAfter = await request(server).get('/api/auth/status').expect(200);
    expect(statusAfter.body.data.initialized).toBe(true);
    await request(server).post('/api/auth/login').send({ password: 'updated-password-999' }).expect(200);
  });

  it('fans out a single due reminder across Bark, DingTalk, Feishu, and Webhook in one tick', async () => {
    const { app, httpPost, scheduler, loginCookie } = await createTestApp();
    const server = app.getHttpServer();
    const cookie = await loginCookie();

    // Return universally accepted JSON responses depending on target URL
    httpPost.mockImplementation(async (opts) => {
      if (opts.url.includes('/push')) return { ok: true, status: 200, text: JSON.stringify({ code: 200, message: 'ok' }) };
      if (opts.url.includes('dingtalk')) return { ok: true, status: 200, text: JSON.stringify({ errcode: 0, errmsg: 'ok' }) };
      if (opts.url.includes('feishu')) return { ok: true, status: 200, text: JSON.stringify({ code: 0, msg: 'ok' }) };
      return { ok: true, status: 200, text: 'ok' };
    });

    const createCh = async (payload: Record<string, unknown>) =>
      (await request(server).post('/api/channels').set('Cookie', cookie).send(payload).expect(201)).body.data.id as string;

    const barkId = await createCh({
      name: 'Bark',
      type: 'bark',
      enabled: true,
      config: { serverUrl: 'http://192.168.1.10:8080', deviceKey: 'dk' },
    });
    const dtId = await createCh({
      name: '钉钉',
      type: 'dingtalk',
      enabled: true,
      config: { webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=t1', secret: 'SEC123' },
    });
    const fsId = await createCh({
      name: '飞书',
      type: 'feishu',
      enabled: true,
      config: { webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/h1', secret: 'fs-sec' },
    });
    const whId = await createCh({
      name: 'Webhook',
      type: 'webhook',
      enabled: true,
      config: { url: 'http://127.0.0.1:9999/notify', secret: 'wh-sec' },
    });

    const rem = await request(server)
      .post('/api/reminders')
      .set('Cookie', cookie)
      .send({
        title: '多渠道并发测试',
        content: '检查全部 4 个渠道',
        scheduledLocal: '2026-11-23T15:00',
        timezone: 'UTC',
        isRepeating: false,
        repeatEvery: null,
        repeatUnit: null,
        channelIds: [barkId, dtId, fsId, whId],
      })
      .expect(201);

    await scheduler.runTick(Date.parse(rem.body.data.nextRunAt) + 2_000);

    const logs = await request(server)
      .get(`/api/deliveries?reminderId=${rem.body.data.id}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(logs.body.data.total).toBe(4);
    expect(logs.body.data.items.every((item: { status: string }) => item.status === 'sent')).toBe(true);
    expect(logs.body.data.items.map((item: { channelType: string }) => item.channelType).sort()).toEqual([
      'bark',
      'dingtalk',
      'feishu',
      'webhook',
    ]);

    // Channel test uses globalTimezone (not hardcoded UTC), and disabled channel accepts config: null
    await request(server).put('/api/settings').set('Cookie', cookie).send({ globalTimezone: 'Asia/Shanghai' }).expect(200);
    const testRes = await request(server).post(`/api/channels/${whId}/test`).set('Cookie', cookie).expect(200);
    expect(testRes.body.data.ok).toBe(true);
    const lastWebhookBody = JSON.parse(httpPost.mock.calls.at(-1)![0].body) as { timezone: string; is_test: boolean };
    expect(lastWebhookBody.timezone).toBe('Asia/Shanghai');
    expect(lastWebhookBody.is_test).toBe(true);

    const draftCh = await request(server)
      .post('/api/channels')
      .set('Cookie', cookie)
      .send({ name: '草稿渠道', type: 'telegram', enabled: false, config: null })
      .expect(201);
    expect(draftCh.body.data.configured).toBe(false);
    await request(server)
      .put(`/api/channels/${draftCh.body.data.id}`)
      .set('Cookie', cookie)
      .send({ name: '草稿渠道2', enabled: false, config: null })
      .expect(200);
  });

  it('creates a valid online SQLite backup via VACUUM INTO during daily maintenance', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tickbell-test-'));
    const dbPath = path.join(tmpDir, 'tickbell.db');
    try {
      const { scheduler } = await createTestApp({ dbPath });
      const result = await scheduler.runDailyMaintenance(Date.UTC(2026, 10, 23, 3, 0, 0));
      expect(result.backupFile).toMatch(/^tickbell-\d{8}-\d{6}\.db$/);
      const backupPath = path.join(tmpDir, 'backups', result.backupFile!);
      expect(fs.existsSync(backupPath)).toBe(true);

      const copy = new Database(backupPath, { readonly: true });
      const row = copy.prepare("SELECT value FROM settings WHERE key = 'global_timezone'").get() as { value: string };
      expect(row.value).toBe('UTC');
      copy.close();
    } finally {
      // appsToClose in afterEach will close the DB; clean up best-effort after a small delay if needed
      while (appsToClose.length) {
        const app = appsToClose.pop();
        if (app) await app.close();
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('migrates an existing 0001 DB to 0002 without losing FK children and runs minute-level repeating reminders', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tickbell-mig-'));
    const dbPath = path.join(tmpDir, 'tickbell.db');
    try {
      // Simulate an existing DB that only applied 0001_init.sql and already has data + FK child rows
      const preDb = new Database(dbPath);
      preDb.pragma('foreign_keys = ON');
      preDb.exec(`
        CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
      `);
      const initSql = fs.readFileSync(path.resolve(__dirname, '../migrations/0001_init.sql'), 'utf8');
      preDb.exec(initSql);
      const now = Date.UTC(2026, 10, 23, 10, 0, 0);
      preDb.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run('0001_init.sql', now);
      preDb
        .prepare('INSERT INTO channels (id, name, type, enabled, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('ch-1', 'Bark', 'bark', 1, JSON.stringify({ serverUrl: 'https://api.day.app', deviceKey: 'k1' }), now, now);
      preDb
        .prepare(
          `INSERT INTO reminders (id, title, content, category, tags, timezone, starts_at, is_repeating, repeat_every, repeat_unit, enabled, completed, next_run_at, schedule_version, created_at, updated_at)
           VALUES (?, ?, ?, '', '[]', 'UTC', ?, 0, NULL, NULL, 1, 0, ?, 0, ?, ?)`,
        )
        .run('rem-existing', '既有提醒', '正文', now + 3600_000, now + 3600_000, now, now);
      preDb.prepare('INSERT INTO reminder_channels (reminder_id, channel_id) VALUES (?, ?)').run('rem-existing', 'ch-1');
      preDb
        .prepare(
          `INSERT INTO deliveries (id, event_id, reminder_id, scheduled_at, channel_id, status, attempts, created_at, updated_at)
           VALUES ('del-1', 'evt-1', 'rem-existing', ?, 'ch-1', 'sent', 1, ?, ?)`,
        )
        .run(now, now, now);
      preDb.close();

      // Booting the app must apply 0002_add_minute_repeat_unit.sql cleanly and preserve all existing rows
      const { app, scheduler, loginCookie } = await createTestApp({ dbPath });
      const server = app.getHttpServer();
      const cookie = await loginCookie();

      const existingRem = await request(server).get('/api/reminders/rem-existing').set('Cookie', cookie).expect(200);
      expect(existingRem.body.data.channelIds).toEqual(['ch-1']);

      // Create a 10-minute repeating reminder and verify scheduler advances it by 10 minutes
      const minRem = await request(server)
        .post('/api/reminders')
        .set('Cookie', cookie)
        .send({
          title: '每 10 分钟提醒',
          scheduledLocal: '2026-11-23T14:00',
          timezone: 'Asia/Shanghai',
          isRepeating: true,
          repeatEvery: 10,
          repeatUnit: 'minute',
          channelIds: ['ch-1'],
        })
        .expect(201);
      expect(minRem.body.data.repeatUnit).toBe('minute');
      expect(minRem.body.data.repeatEvery).toBe(10);

      const t0 = Date.parse(minRem.body.data.nextRunAt);
      await scheduler.runTick(t0 + 2_000);
      const after = await request(server).get(`/api/reminders/${minRem.body.data.id}`).set('Cookie', cookie).expect(200);
      expect(Date.parse(after.body.data.nextRunAt)).toBe(t0 + 10 * 60 * 1000);
    } finally {
      while (appsToClose.length) {
        const app = appsToClose.pop();
        if (app) await app.close();
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('supports configurable auto JSON backup to data/backups with retention pruning, file read/delete, and restore preservation', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tickbell-autobackup-'));
    const dbPath = path.join(tmpDir, 'tickbell.db');
    try {
      const { app, loginCookie } = await createTestApp({ dbPath });
      const server = app.getHttpServer();
      const backupService = app.get(BackupService);
      const cookie = await loginCookie();

      // 1. Default auto-backup state
      const initial = await request(server).get('/api/backup/auto').set('Cookie', cookie).expect(200);
      expect(initial.body.data.config).toEqual({
        enabled: false,
        time: '03:00',
        intervalEvery: 1,
        intervalUnit: 'day',
        maxFiles: 10,
      });
      expect(initial.body.data.files).toEqual([]);
      expect(initial.body.data.backupDir).toBe(path.join(tmpDir, 'backups'));

      // 2. Reject invalid config
      await request(server)
        .put('/api/backup/auto')
        .set('Cookie', cookie)
        .send({ enabled: true, time: '25:99', intervalEvery: 1, intervalUnit: 'day', maxFiles: 5 })
        .expect(400);
      await request(server)
        .put('/api/backup/auto')
        .set('Cookie', cookie)
        .send({ enabled: true, time: '09:00', intervalEvery: 1, intervalUnit: 'day', maxFiles: 0 })
        .expect(400);

      // Seed one channel and one reminder so exported backup has real content
      const ch = await request(server)
        .post('/api/channels')
        .set('Cookie', cookie)
        .send({
          name: '自动备份渠道',
          type: 'bark',
          enabled: true,
          config: { serverUrl: 'https://api.day.app', deviceKey: 'auto-bak-key' },
        })
        .expect(201);
      await request(server)
        .post('/api/reminders')
        .set('Cookie', cookie)
        .send({
          title: '自动备份测试提醒',
          scheduledLocal: '2026-12-01T09:00',
          timezone: 'Asia/Shanghai',
          isRepeating: false,
          repeatEvery: null,
          repeatUnit: null,
          channelIds: [ch.body.data.id],
        })
        .expect(201);

      // 3. Enable auto-backup every 6 hours anchored at 09:00, maxFiles = 2
      const updated = await request(server)
        .put('/api/backup/auto')
        .set('Cookie', cookie)
        .send({ enabled: true, time: '09:00', intervalEvery: 6, intervalUnit: 'hour', maxFiles: 2 })
        .expect(200);
      expect(updated.body.data.config).toEqual({
        enabled: true,
        time: '09:00',
        intervalEvery: 6,
        intervalUnit: 'hour',
        maxFiles: 2,
      });
      const scheduledNextRunAt = updated.body.data.state.nextRunAt as string;
      expect(scheduledNextRunAt).toBeTruthy();

      // 4. Manual run writes file to data/backups and preserves upcoming nextRunAt
      const manualRun = await request(server).post('/api/backup/auto/run').set('Cookie', cookie).expect(200);
      const firstFileName = manualRun.body.data.file.name as string;
      expect(firstFileName).toMatch(/^tickbell-auto-\d{8}-\d{6}\.json$/);
      expect(manualRun.body.data.view.state.nextRunAt).toBe(scheduledNextRunAt);
      expect(fs.existsSync(path.join(tmpDir, 'backups', firstFileName))).toBe(true);

      // 5. Trigger two due scheduled runs (6 hours apart) -> 3 total runs, pruned down to maxFiles = 2
      const firstDueMs = Date.parse(scheduledNextRunAt);
      expect(backupService.runAutoBackupIfDue(firstDueMs - 1_000)).toBe(false);
      expect(backupService.runAutoBackupIfDue(firstDueMs + 2_000)).toBe(true);
      const secondDueMs = Date.parse(backupService.getAutoBackupView().state.nextRunAt!);
      expect(secondDueMs).toBe(firstDueMs + 6 * 3600_000);
      expect(backupService.runAutoBackupIfDue(secondDueMs + 2_000)).toBe(true);

      const afterRuns = await request(server).get('/api/backup/auto').set('Cookie', cookie).expect(200);
      expect(afterRuns.body.data.files).toHaveLength(2);
      const newestFileName = afterRuns.body.data.files[0].name as string;
      const diskFiles = fs.readdirSync(path.join(tmpDir, 'backups')).filter((f) => f.startsWith('tickbell-auto-'));
      expect(diskFiles).toHaveLength(2);

      // 6. Read auto-backup file and verify slim format (no deliveries/receipts, has reminders & channels)
      const fetched = await request(server)
        .get(`/api/backup/auto/files/${encodeURIComponent(newestFileName)}`)
        .set('Cookie', cookie)
        .expect(200);
      expect(fetched.body.data.name).toBe(newestFileName);
      expect(fetched.body.data.backup.format).toBe('tickbell-full-backup');
      expect(fetched.body.data.backup.version).toBe(2);
      expect(fetched.body.data.backup.reminders).toHaveLength(1);
      expect(fetched.body.data.backup.channels).toHaveLength(1);
      expect(fetched.body.data.backup.deliveries).toBeUndefined();
      expect(fetched.body.data.backup.receipts).toBeUndefined();

      // 7. Reject path traversal / invalid filenames
      await request(server).get('/api/backup/auto/files/..%2Fsecret.json').set('Cookie', cookie).expect(400);
      await request(server).get('/api/backup/auto/files/not-a-backup.json').set('Cookie', cookie).expect(400);
      await request(server).delete('/api/backup/auto/files/not-a-backup.json').set('Cookie', cookie).expect(400);

      // 8. Restoring from that backup file preserves auto_backup_config
      await request(server)
        .post('/api/backup/restore')
        .set('Cookie', cookie)
        .send({ backup: fetched.body.data.backup, password: 'test-admin-password', confirmation: 'RESTORE' })
        .expect(200);
      const newCookie = await loginCookie();
      const afterRestore = await request(server).get('/api/backup/auto').set('Cookie', newCookie).expect(200);
      expect(afterRestore.body.data.config).toEqual({
        enabled: true,
        time: '09:00',
        intervalEvery: 6,
        intervalUnit: 'hour',
        maxFiles: 2,
      });

      // 9. Delete one auto-backup file
      const afterDelete = await request(server)
        .delete(`/api/backup/auto/files/${encodeURIComponent(newestFileName)}`)
        .set('Cookie', newCookie)
        .expect(200);
      expect(afterDelete.body.data).toHaveLength(1);
      expect(fs.existsSync(path.join(tmpDir, 'backups', newestFileName))).toBe(false);

      // 10. Changing global timezone automatically recalculates nextRunAt and preserves chronological pruning
      const beforeTzNext = afterRestore.body.data.state.nextRunAt as string;
      await request(server)
        .put('/api/settings')
        .set('Cookie', newCookie)
        .send({ globalTimezone: 'Asia/Shanghai' })
        .expect(200);
      const afterShanghai = await request(server).get('/api/backup/auto').set('Cookie', newCookie).expect(200);
      expect(afterShanghai.body.data.timezone).toBe('Asia/Shanghai');
      expect(afterShanghai.body.data.state.nextRunAt).not.toBe(beforeTzNext);

      const tA = Date.UTC(2027, 0, 15, 10, 0, 0); // 18:00 Shanghai
      const shanghaiRun = backupService.runAutoBackupNow(tA);
      expect(shanghaiRun.file.name).toBe('tickbell-auto-20270115-180000.json');

      await request(server)
        .put('/api/settings')
        .set('Cookie', newCookie)
        .send({ globalTimezone: 'UTC' })
        .expect(200);
      // 10s later in UTC -> filename is 10:00:10 (lexicographically earlier than 18:00:00), must still sort first and survive pruning!
      const utcRun = backupService.runAutoBackupNow(tA + 10_000);
      expect(utcRun.file.name).toBe('tickbell-auto-20270115-100010.json');
      expect(utcRun.view.files).toHaveLength(2);
      expect(utcRun.view.files[0]?.name).toBe('tickbell-auto-20270115-100010.json');
      expect(utcRun.view.files[1]?.name).toBe('tickbell-auto-20270115-180000.json');
      expect(fs.existsSync(path.join(tmpDir, 'backups', utcRun.file.name))).toBe(true);
    } finally {
      while (appsToClose.length) {
        const app = appsToClose.pop();
        if (app) await app.close();
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
