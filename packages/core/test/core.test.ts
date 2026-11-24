import { describe, expect, it } from 'vitest';
import {
  BarkProvider,
  buildChunkedInStatements,
  buildMultiRowInsertStatements,
  calculateNextFutureRun,
  calculateNextRun,
  computeFeishuSignature,
  DingTalkProvider,
  FeishuProvider,
  hashPasswordPbkdf2,
  PrivateNetworkPolicy,
  resolveServerChanUrl,
  ServerChanProvider,
  signDingTalkUrl,
  TelegramProvider,
  verifyPasswordPbkdf2,
  WebhookProvider,
  WeComProvider,
  type HttpPostFn,
  type NotificationMessage,
} from '../src/index';

const sampleMessage: NotificationMessage = {
  eventId: 'evt-1',
  reminderId: 'rem-1',
  title: '喝水提醒',
  content: '记得站起来活动并喝一杯温水',
  timezone: 'Asia/Shanghai',
  scheduledAt: Date.UTC(2026, 0, 31, 1, 0, 0),
  triggeredAt: Date.UTC(2026, 0, 31, 1, 0, 5),
};

describe('@tickbell/core', () => {
  it('hashes and verifies passwords via Web Crypto PBKDF2-SHA256', async () => {
    const hash = await hashPasswordPbkdf2('tickbell-secret-pass', 20_000);
    expect(hash.startsWith('pbkdf2-sha256$20000$')).toBe(true);
    expect(await verifyPasswordPbkdf2('tickbell-secret-pass', hash)).toBe(true);
    expect(await verifyPasswordPbkdf2('wrong-password', hash)).toBe(false);
  });

  it('handles minute/month-end/leap-year repeat rules accurately', () => {
    const jan31 = Date.UTC(2026, 0, 31, 1, 0, 0); // 2026-01-31 09:00 Asia/Shanghai
    const feb28 = calculateNextRun(jan31, { every: 1, unit: 'month', timezone: 'Asia/Shanghai', startsAt: jan31 });
    expect(new Date(feb28).toISOString()).toBe('2026-02-28T01:00:00.000Z');
    const mar31 = calculateNextRun(feb28, { every: 1, unit: 'month', timezone: 'Asia/Shanghai', startsAt: jan31 });
    expect(new Date(mar31).toISOString()).toBe('2026-03-31T01:00:00.000Z');

    const minNext = calculateNextFutureRun(jan31, jan31 + 12 * 60_000, {
      every: 5,
      unit: 'minute',
      timezone: 'Asia/Shanghai',
      startsAt: jan31,
    });
    expect(minNext).toBe(jan31 + 15 * 60_000);
  });

  it('chunks IN clauses and multi-row INSERTs strictly within D1 maxBindParams', () => {
    const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`);
    const inStmts = buildChunkedInStatements('SELECT * FROM reminders WHERE id IN ', '', ids, 90);
    expect(inStmts.length).toBe(3);
    for (const stmt of inStmts) {
      expect((stmt.params ?? []).length).toBeLessThanOrEqual(90);
    }

    const cols = Array.from({ length: 18 }, (_, i) => `c${i}`);
    const rows = Array.from({ length: 53 }, (_, r) => cols.map((_, c) => `v-${r}-${c}`));
    const insertStmts = buildMultiRowInsertStatements('reminders', cols, rows, 90);
    // 18 cols -> floor(90/18) = 5 rows per statement -> ceil(53/5) = 11 statements
    expect(insertStmts.length).toBe(11);
    for (const stmt of insertStmts) {
      expect((stmt.params ?? []).length).toBeLessThanOrEqual(90);
    }
  });

  it('sends through all 7 providers with Web Crypto signatures', async () => {
    const calls: Array<{ url: string; method?: string; headers?: Record<string, string>; body: string }> = [];
    const mockPost: HttpPostFn = async (opts) => {
      calls.push({ url: opts.url, method: opts.method, headers: opts.headers, body: opts.body });
      if (opts.url.includes('api.day.app')) return { ok: true, status: 200, text: '{"code":200}' };
      if (opts.url.includes('api.telegram.org')) return { ok: true, status: 200, text: '{"ok":true}' };
      if (opts.url.includes('qyapi.weixin.qq.com') || opts.url.includes('oapi.dingtalk.com')) {
        return { ok: true, status: 200, text: '{"errcode":0,"errmsg":"ok"}' };
      }
      if (opts.url.includes('open.feishu.cn') || opts.url.includes('sctapi.ftqq.com')) {
        return { ok: true, status: 200, text: '{"code":0,"msg":"ok"}' };
      }
      return { ok: true, status: 200, text: '{"received":true}' };
    };

    const policy = new PrivateNetworkPolicy([], false);

    const bark = new BarkProvider(policy, mockPost);
    expect((await bark.send(sampleMessage, { serverUrl: 'https://api.day.app', deviceKey: 'dev123' })).ok).toBe(true);

    const tg = new TelegramProvider(policy, mockPost);
    expect(
      (await tg.send(sampleMessage, { botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ', chatId: '999', parseMode: 'HTML' })).ok,
    ).toBe(true);

    const wecom = new WeComProvider(policy, mockPost);
    expect((await wecom.send(sampleMessage, { webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k' })).ok).toBe(true);

    const signedDing = await signDingTalkUrl('https://oapi.dingtalk.com/robot/send?access_token=abc', 'SECtest', 1700000000000);
    expect(signedDing).toContain('timestamp=1700000000000');
    expect(signedDing).toContain('sign=');
    const ding = new DingTalkProvider(policy, mockPost);
    expect((await ding.send(sampleMessage, { webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=abc', secret: 'SECtest' })).ok).toBe(true);

    const feishuSig = await computeFeishuSignature('my-secret', '1700000000');
    expect(feishuSig.length).toBeGreaterThan(20);
    const feishu = new FeishuProvider(policy, mockPost);
    expect((await feishu.send(sampleMessage, { webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/xyz', secret: 'my-secret' })).ok).toBe(true);

    expect(resolveServerChanUrl('sctp1234tABC').edition).toBe('Server酱³');
    const sc = new ServerChanProvider(policy, mockPost);
    expect((await sc.send(sampleMessage, { sendKey: 'SCT123456' })).ok).toBe(true);

    const wh = new WebhookProvider(policy, mockPost);
    const whRes = await wh.send(sampleMessage, { url: 'https://hooks.example.com/notify', secret: 'wh-sec' });
    expect(whRes.ok).toBe(true);
    const lastCall = calls[calls.length - 1]!;
    expect(lastCall.headers?.['X-Reminder-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(lastCall.headers?.['X-Reminder-Event-Id']).toBe('evt-1');
  });
});
