import { describe, expect, it, vi } from 'vitest';
import { loadAppConfig } from '../src/config/app-config';
import {
  type HttpPostFn,
  RetryableNetworkError,
  SsrfBlockedError,
  UnknownNetworkError,
} from '../src/modules/notifications/http/pinned-fetch';
import { BarkProvider } from '../src/modules/notifications/providers/bark.provider';

describe('BarkProvider send & error classification', () => {
  const baseConfig = loadAppConfig({ NODE_ENV: 'test' });
  const baseMessage = {
    eventId: 'evt-1',
    reminderId: 'rem-1',
    title: '吃药提醒',
    content: '饭后一粒',
    timezone: 'Asia/Shanghai',
    scheduledAt: Date.UTC(2026, 10, 23, 4, 0, 0),
    triggeredAt: Date.UTC(2026, 10, 23, 4, 0, 5),
  };

  it('sends Bark JSON payload and appends late note when isLate=true', async () => {
    const httpPost = vi.fn<HttpPostFn>().mockResolvedValue({
      ok: true,
      status: 200,
      text: JSON.stringify({ code: 200, message: 'success' }),
    });
    const bark = new BarkProvider(baseConfig, httpPost);

    const res = await bark.send(
      { ...baseMessage, isLate: true },
      {
        serverUrl: 'http://192.168.1.10:8080',
        deviceKey: 'dk-1',
        group: '个人提醒',
        level: 'critical',
        sound: 'alarm',
        call: true,
        volume: 9,
        icon: 'https://example.com/icon.png',
        isArchive: false,
      },
    );

    expect(res.ok).toBe(true);
    expect(res.httpStatus).toBe(200);
    expect(httpPost).toHaveBeenCalledTimes(1);
    const call = httpPost.mock.calls[0]![0];
    expect(call.url).toBe('http://192.168.1.10:8080/push');
    const body = JSON.parse(call.body) as Record<string, unknown>;
    expect(body.device_key).toBe('dk-1');
    expect(body.group).toBe('个人提醒');
    expect(body.level).toBe('critical');
    expect(body.call).toBe('1');
    expect(body.volume).toBe('9');
    expect(body.icon).toBe('https://example.com/icon.png');
    expect(body.isArchive).toBe('0');
    expect(String(body.body)).toContain('延迟送达');
  });

  it('classifies HTTP 503 / 429 and network errors as retryable', async () => {
    const httpPost = vi.fn<HttpPostFn>().mockResolvedValue({ ok: false, status: 503, text: 'upstream unavailable' });
    const bark = new BarkProvider(baseConfig, httpPost);

    const r1 = await bark.send(baseMessage, { serverUrl: 'https://api.day.app', deviceKey: 'dk-1' });
    expect(r1.ok).toBe(false);
    expect(r1.errorClass).toBe('retryable');

    httpPost.mockRejectedValueOnce(new RetryableNetworkError('ECONNREFUSED'));
    const r2 = await bark.send(baseMessage, { serverUrl: 'https://api.day.app', deviceKey: 'dk-1' });
    expect(r2.ok).toBe(false);
    expect(r2.errorClass).toBe('retryable');
  });

  it('classifies 4xx, Bark business error, and SSRF block as permanent', async () => {
    const httpPost = vi.fn<HttpPostFn>().mockResolvedValue({
      ok: true,
      status: 200,
      text: JSON.stringify({ code: 400, message: 'failed to get device token' }),
    });
    const bark = new BarkProvider(baseConfig, httpPost);

    const r1 = await bark.send(baseMessage, { serverUrl: 'https://api.day.app', deviceKey: 'bad' });
    expect(r1.ok).toBe(false);
    expect(r1.errorClass).toBe('permanent');

    httpPost.mockRejectedValueOnce(new SsrfBlockedError('blocked'));
    const r2 = await bark.send(baseMessage, { serverUrl: 'https://api.day.app', deviceKey: 'bad' });
    expect(r2.errorClass).toBe('permanent');
  });

  it('classifies read timeouts as unknown (no auto-retry)', async () => {
    const httpPost = vi.fn<HttpPostFn>().mockRejectedValue(new UnknownNetworkError('timeout'));
    const bark = new BarkProvider(baseConfig, httpPost);

    const res = await bark.send(baseMessage, { serverUrl: 'https://api.day.app', deviceKey: 'dk-1' });
    expect(res.ok).toBe(false);
    expect(res.errorClass).toBe('unknown');
  });
});
