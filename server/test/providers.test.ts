import * as crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { loadAppConfig } from '../src/config/app-config';
import {
  contentHtmlToTelegramHtml,
  escapeAndTruncateHtml,
  truncateByChars,
  truncateByUtf8Bytes,
} from '../src/modules/notifications/http/message-format';
import {
  type HttpPostFn,
  sanitizeSensitiveText,
} from '../src/modules/notifications/http/pinned-fetch';
import { PrivateNetworkPolicy } from '../src/modules/notifications/http/url-policy';
import { DingTalkProvider, signDingTalkUrl } from '../src/modules/notifications/providers/dingtalk.provider';
import { computeFeishuSignature, FeishuProvider } from '../src/modules/notifications/providers/feishu.provider';
import { resolveServerChanUrl, ServerChanProvider } from '../src/modules/notifications/providers/serverchan.provider';
import { TelegramProvider } from '../src/modules/notifications/providers/telegram.provider';
import { WebhookProvider } from '../src/modules/notifications/providers/webhook.provider';
import { WeComProvider } from '../src/modules/notifications/providers/wecom.provider';

describe('shared formatting & redaction helpers', () => {
  it('truncates UTF-16 chars without splitting emoji surrogate pairs and UTF-8 bytes without splitting Chinese chars', () => {
    const emojis = '😀'.repeat(10); // length 20
    const cutChars = truncateByChars(emojis, 15, '…');
    expect(cutChars.length).toBeLessThanOrEqual(15);
    // Ensure no lone high surrogate remains before ellipsis
    expect(/[\uD800-\uDBFF]…$/.test(cutChars)).toBe(false);

    const chinese = '你好世界'.repeat(100); // 1200 bytes
    const cutBytes = truncateByUtf8Bytes(chinese, 100, '…');
    expect(Buffer.byteLength(cutBytes, 'utf8')).toBeLessThanOrEqual(100);
    expect(cutBytes.includes('\uFFFD')).toBe(false);
  });

  it('redacts sensitive tokens and query parameters from error text', () => {
    const raw =
      'POST https://api.telegram.org/bot123456:AAHsecretToken_1234567890/sendMessage '
      + 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc-123 '
      + 'https://oapi.dingtalk.com/robot/send?access_token=dt-999&sign=sig-888 '
      + 'https://open.feishu.cn/open-apis/bot/v2/hook/feishu-hook-secret-uuid '
      + 'https://sctapi.ftqq.com/SCT123456Txyz.send '
      + 'https://sctapi.ftqq.com/sct987654tlower.send '
      + 'https://99.push.ft07.com/send/sctp99tABC.send';
    const clean = sanitizeSensitiveText(raw);
    expect(clean).not.toContain('AAHsecretToken_1234567890');
    expect(clean).not.toContain('abc-123');
    expect(clean).not.toContain('dt-999');
    expect(clean).not.toContain('sig-888');
    expect(clean).not.toContain('feishu-hook-secret-uuid');
    expect(clean).not.toContain('SCT123456Txyz');
    expect(clean).not.toContain('sct987654tlower');
    expect(clean).not.toContain('sctp99tABC');
    expect(clean).toContain('[REDACTED]');
  });

  it('safely truncates HTML-escaped text and filters unsafe Telegram href schemes', () => {
    const heavy = '<&>"'.repeat(30); // expands >5x when escaped
    const out = escapeAndTruncateHtml(heavy, 60, '…');
    expect(out.length).toBeLessThanOrEqual(60);
    // Must never leave a broken trailing HTML entity like `&am`
    expect(/&[a-z]*$/.test(out)).toBe(false);

    const html = '<p><a href="javascript:alert(1)">bad</a> and <a href="https://example.com">good</a></p>';
    const tgHtml = contentHtmlToTelegramHtml(html);
    expect(tgHtml).not.toContain('javascript:');
    expect(tgHtml).toContain('bad');
    expect(tgHtml).toContain('<a href="https://example.com">good</a>');
  });
});

describe('notification channel providers', () => {
  const baseConfig = loadAppConfig({ NODE_ENV: 'test' });
  const policy = new PrivateNetworkPolicy([], true);
  const sampleMessage = {
    eventId: 'evt-100',
    reminderId: 'rem-100',
    title: '服务器证书续期',
    content: '检查 Nginx 与 Caddy 证书状态',
    contentHtml: '<p>检查 <strong>Nginx</strong> 与 <a href="https://example.com/">Caddy</a></p>',
    timezone: 'Asia/Shanghai',
    scheduledAt: Date.UTC(2026, 10, 23, 4, 0, 0),
    triggeredAt: Date.UTC(2026, 10, 23, 4, 0, 5),
  };

  it('TelegramProvider supports custom proxy, HTML mode, 4096 truncation, and 429 retry classification', async () => {
    const httpPost = vi.fn<HttpPostFn>().mockResolvedValue({
      ok: true,
      status: 200,
      text: JSON.stringify({ ok: true, result: { message_id: 1 } }),
    });
    const tg = new TelegramProvider(baseConfig, httpPost);

    const cfg = tg.mergeConfig(
      {
        apiBaseUrl: 'https://tg-proxy.example.com/',
        botToken: '123456789:AAH0123456789abcdefghijk',
        chatId: '-1001234567',
        messageThreadId: 42,
        parseMode: 'HTML',
        disableNotification: true,
        protectContent: true,
      },
      null,
      true,
      policy,
    )!;
    expect(tg.maskConfig(cfg).summary.some((s) => s.value.includes('-1001234567'))).toBe(true);

    const res = await tg.send(sampleMessage, cfg);
    expect(res.ok).toBe(true);
    const req = httpPost.mock.calls[0]![0];
    expect(req.url).toBe('https://tg-proxy.example.com/bot123456789:AAH0123456789abcdefghijk/sendMessage');
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body.chat_id).toBe('-1001234567');
    expect(body.message_thread_id).toBe(42);
    expect(body.parse_mode).toBe('HTML');
    expect(body.protect_content).toBe(true);
    expect(String(body.text)).toContain('<b>服务器证书续期</b>');

    // Rate limited 429 -> retryable, and HTML fallback truncation with heavy escaping must preserve closing </i> tag
    httpPost.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests' }),
    });
    const limited = await tg.send({ ...sampleMessage, content: '<&>"'.repeat(1500), contentHtml: null }, cfg);
    expect(limited.ok).toBe(false);
    expect(limited.errorClass).toBe('retryable');
    const truncBody = JSON.parse(httpPost.mock.calls[1]![0].body) as { text: string };
    expect(truncBody.text.length).toBeLessThanOrEqual(4096);
    expect(truncBody.text.endsWith('</i>')).toBe(true);

    // Clearing optional numeric messageThreadId via null works cleanly
    const cleared = tg.mergeConfig({ messageThreadId: null }, cfg, true, policy)!;
    expect(cleared.messageThreadId).toBeUndefined();
  });

  it('WeComProvider supports markdown/text, @all, UTF-8 byte truncation, and 45009 retryable code', async () => {
    const httpPost = vi.fn<HttpPostFn>().mockResolvedValue({
      ok: true,
      status: 200,
      text: JSON.stringify({ errcode: 0, errmsg: 'ok' }),
    });
    const wecom = new WeComProvider(baseConfig, httpPost);

    const cfg = wecom.mergeConfig(
      {
        webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-key',
        msgType: 'text',
        mentionedMobileList: '13800138000, 13900139000',
        mentionAll: true,
      },
      null,
      true,
      policy,
    )!;
    const res = await wecom.send({ ...sampleMessage, content: '中'.repeat(1000) }, cfg);
    expect(res.ok).toBe(true);
    const body = JSON.parse(httpPost.mock.calls[0]![0].body) as {
      msgtype: string;
      text: { content: string; mentioned_list: string[]; mentioned_mobile_list: string[] };
    };
    expect(body.msgtype).toBe('text');
    expect(Buffer.byteLength(body.text.content, 'utf8')).toBeLessThanOrEqual(2048);
    expect(body.text.mentioned_list).toContain('@all');
    expect(body.text.mentioned_mobile_list).toEqual(['13800138000', '13900139000']);

    httpPost.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: JSON.stringify({ errcode: 45009, errmsg: 'api freq out of limit' }),
    });
    const limited = await wecom.send(sampleMessage, cfg);
    expect(limited.ok).toBe(false);
    expect(limited.errorClass).toBe('retryable');

    // Summary shows @指定成员 when only mentionedList (UserIDs) is configured
    const uidCfg = wecom.mergeConfig(
      { webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k', msgType: 'text', mentionedList: 'zhangsan' },
      null,
      true,
      policy,
    )!;
    expect(wecom.maskConfig(uidCfg).summary.some((s) => s.value.includes('@指定成员'))).toBe(true);
  });

  it('DingTalkProvider signs URL with HMAC-SHA256, ensures keyword, highlights @mobiles, and classifies 130101 vs 310000', async () => {
    const signed = signDingTalkUrl('https://oapi.dingtalk.com/robot/send?access_token=abc', 'SECtest', 1700000000000);
    const parsedUrl = new URL(signed);
    const expectedSign = crypto
      .createHmac('sha256', 'SECtest')
      .update('1700000000000\nSECtest', 'utf8')
      .digest('base64');
    expect(parsedUrl.searchParams.get('timestamp')).toBe('1700000000000');
    expect(parsedUrl.searchParams.get('sign')).toBe(expectedSign);

    const httpPost = vi.fn<HttpPostFn>().mockResolvedValue({
      ok: true,
      status: 200,
      text: JSON.stringify({ errcode: 0, errmsg: 'ok' }),
    });
    const dt = new DingTalkProvider(baseConfig, httpPost);
    const cfg = dt.mergeConfig(
      {
        webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=abc',
        secret: 'SECtest',
        keyword: '告警',
        msgType: 'markdown',
        atMobiles: '13800138000',
        atUserIds: 'user_01',
      },
      null,
      true,
      policy,
    )!;
    const res = await dt.send(sampleMessage, cfg);
    expect(res.ok).toBe(true);
    const call = httpPost.mock.calls[0]![0];
    expect(call.url).toContain('sign=');
    const body = JSON.parse(call.body) as {
      markdown: { title: string; text: string };
      at: { atMobiles: string[]; atUserIds: string[] };
    };
    expect(body.markdown.title).toContain('[告警]');
    expect(body.markdown.text).toContain('@13800138000');
    expect(body.markdown.text).toContain('@user_01');
    expect(body.at.atMobiles).toEqual(['13800138000']);
    expect(body.at.atUserIds).toEqual(['user_01']);

    // Keyword at end of oversized content is still guaranteed after truncation
    await dt.send({ ...sampleMessage, content: `${'长'.repeat(8000)}告警` }, cfg);
    const truncBody = JSON.parse(httpPost.mock.calls[1]![0].body) as { markdown: { title: string; text: string } };
    expect(Buffer.byteLength(truncBody.markdown.text, 'utf8')).toBeLessThanOrEqual(19 * 1024);
    expect(truncBody.markdown.title).toContain('[告警]');

    httpPost.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: JSON.stringify({ errcode: 130101, errmsg: 'send too fast' }),
    });
    expect((await dt.send(sampleMessage, cfg)).errorClass).toBe('retryable');

    httpPost.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: JSON.stringify({ errcode: 310000, errmsg: 'sign not match' }),
    });
    expect((await dt.send(sampleMessage, cfg)).errorClass).toBe('permanent');
  });

  it('FeishuProvider computes official key=timestamp\\nsecret HMAC, sends interactive card, and handles code/StatusCode', async () => {
    const sig = computeFeishuSignature('my-secret', '1700000000');
    const expected = crypto.createHmac('sha256', '1700000000\nmy-secret').digest('base64');
    expect(sig).toBe(expected);

    const httpPost = vi.fn<HttpPostFn>().mockResolvedValue({
      ok: true,
      status: 200,
      text: JSON.stringify({ StatusCode: 0, StatusMessage: 'success' }),
    });
    const feishu = new FeishuProvider(baseConfig, httpPost);
    const cfg = feishu.mergeConfig(
      {
        webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/hook-id',
        secret: 'my-secret',
        msgType: 'interactive',
        cardHeaderColor: 'indigo',
        mentionAll: true,
      },
      null,
      true,
      policy,
    )!;
    const res = await feishu.send({ ...sampleMessage, isLate: true }, cfg);
    expect(res.ok).toBe(true);
    const body = JSON.parse(httpPost.mock.calls[0]![0].body) as {
      msg_type: string;
      timestamp: string;
      sign: string;
      card: { header: { template: string } };
    };
    expect(body.msg_type).toBe('interactive');
    expect(body.sign).toBe(computeFeishuSignature('my-secret', body.timestamp));
    // Late reminders highlight card header in orange
    expect(body.card.header.template).toBe('orange');

    httpPost.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: JSON.stringify({ code: 11232, msg: 'frequency limited' }),
    });
    expect((await feishu.send(sampleMessage, cfg)).errorClass).toBe('retryable');

    httpPost.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: JSON.stringify({ code: 19021, msg: 'sign match fail' }),
    });
    expect((await feishu.send(sampleMessage, cfg)).errorClass).toBe('permanent');
  });

  it('ServerChanProvider routes Turbo vs ServerChan3 vs custom URL and preserves >32 char titles in desp', async () => {
    expect(resolveServerChanUrl('SCT12345Tkey').url).toBe('https://sctapi.ftqq.com/SCT12345Tkey.send');
    expect(resolveServerChanUrl('sctp8842tAbcDef').url).toBe('https://8842.push.ft07.com/send/sctp8842tAbcDef.send');
    expect(resolveServerChanUrl('SCT1', 'http://192.168.1.5:8080/push').url).toBe('http://192.168.1.5:8080/push');

    const httpPost = vi.fn<HttpPostFn>().mockResolvedValue({
      ok: true,
      status: 200,
      text: JSON.stringify({ code: 0, message: '' }),
    });
    const sc = new ServerChanProvider(baseConfig, httpPost);
    const cfg = sc.mergeConfig({ sendKey: 'sctp8842tAbcDef', tags: '提醒|运维', noip: true }, null, true, policy)!;
    const longTitle = '这是一个超过三十二个字符长度的非常非常长的提醒事项标题用于测试防丢失截断';
    const res = await sc.send({ ...sampleMessage, title: longTitle }, cfg);
    expect(res.ok).toBe(true);
    const body = JSON.parse(httpPost.mock.calls[0]![0].body) as { title: string; desp: string; noip: number };
    expect(body.title.length).toBeLessThanOrEqual(32);
    expect(body.desp).toContain(longTitle);
    expect(body.noip).toBe(1);
  });

  it('WebhookProvider supports PUT, custom headers, HMAC signature, and JSON-escaped bodyTemplate', async () => {
    const httpPost = vi.fn<HttpPostFn>().mockResolvedValue({ ok: true, status: 204, text: '' });
    const wh = new WebhookProvider(baseConfig, httpPost);

    const cfg = wh.mergeConfig(
      {
        url: 'http://192.168.1.20:9000/hook',
        method: 'PUT',
        secret: 'wh-secret',
        headersText: 'content-type: application/json; charset=utf-8\nAuthorization: Bearer token-123\nX-Custom: hello',
        bodyTemplate: '{"subject": "{{title}}", "text": "{{content}}", "late": {{isLate}}, "test": {{isTest}}}',
      },
      null,
      true,
      policy,
    )!;

    const res = await wh.send({ ...sampleMessage, title: '带"引号"的标题', content: '第一行\n第二行', isTest: true }, cfg);
    expect(res.ok).toBe(true);
    const call = httpPost.mock.calls[0]![0];
    expect(call.method).toBe('PUT');
    expect(call.headers?.Authorization).toBe('Bearer token-123');
    // Case-insensitive Content-Type deduplication: only one content-type header key should exist
    const ctKeys = Object.keys(call.headers ?? {}).filter((k) => k.toLowerCase() === 'content-type');
    expect(ctKeys).toEqual(['content-type']);
    expect(call.headers?.['X-Reminder-Event-Id']).toBe('evt-100');
    const ts = call.headers?.['X-Reminder-Timestamp']!;
    const expectedSig = `sha256=${crypto.createHmac('sha256', 'wh-secret').update(`${ts}.${call.body}`).digest('hex')}`;
    expect(call.headers?.['X-Reminder-Signature']).toBe(expectedSig);

    const parsedBody = JSON.parse(call.body) as { subject: string; text: string; late: boolean; test: boolean };
    expect(parsedBody).toEqual({ subject: '带"引号"的标题', text: '第一行\n第二行', late: false, test: true });

    // Rejects invalid template JSON at save time
    expect(() =>
      wh.mergeConfig({ url: 'https://example.com/hook', bodyTemplate: '{bad json' }, null, true, policy),
    ).toThrow('不是合法的 JSON');
    // Rejects forbidden system header
    expect(() =>
      wh.mergeConfig({ url: 'https://example.com/hook', headersText: 'Host: evil.com' }, null, true, policy),
    ).toThrow('系统保留请求头');
  });
});
