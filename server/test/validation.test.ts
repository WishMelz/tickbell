import { describe, expect, it } from 'vitest';
import { contentHtmlToText, sanitizeContentHtml } from '../src/common/reminder-content';
import { loadAppConfig } from '../src/config/app-config';
import { parsePublicHttpUrl, PrivateNetworkPolicy } from '../src/modules/notifications/http/url-policy';
import { BarkProvider } from '../src/modules/notifications/providers/bark.provider';
import { validateReminderBatchInput, validateReminderInput } from '../src/modules/reminders/reminders.validation';

describe('validation & sanitization', () => {
  it('sanitizes XSS and extracts plain text with links', () => {
    const dirty = '<p>Hello <strong>world</strong><script>alert(1)</script><a href="https://example.com" onclick="x()">docs</a><a href="javascript:alert(1)">bad</a></p>';
    const clean = sanitizeContentHtml(dirty);
    expect(clean).not.toContain('<script>');
    expect(clean).not.toContain('onclick');
    expect(clean).not.toContain('javascript:');
    expect(clean).toContain('href="https://example.com/"');
    expect(contentHtmlToText(clean)).toBe('Hello worlddocs (https://example.com/)bad');
  });

  it('validates reminder inputs and batch inputs', () => {
    const res = validateReminderInput(
      {
        title: '  交水电费  ',
        contentHtml: '<p>记得缴费</p>',
        category: '生活',
        tags: ['账单', '账单', ' 每月 '],
        scheduledLocal: '2026-12-01T09:00',
        timezone: null,
        isRepeating: true,
        repeatEvery: 1,
        repeatUnit: 'month',
        channelIds: ['ch-1'],
      },
      'Asia/Shanghai',
    );
    expect(res.input.title).toBe('交水电费');
    expect(res.input.content).toBe('记得缴费');
    expect(res.input.tags).toEqual(['账单', '每月']);
    expect(res.effectiveTimezone).toBe('Asia/Shanghai');

    expect(() =>
      validateReminderInput(
        {
          title: 'x',
          scheduledLocal: '2026-12-01T09:00',
          timezone: null,
          isRepeating: false,
          repeatEvery: null,
          repeatUnit: null,
          channelIds: [],
        },
        'UTC',
      ),
    ).toThrow('至少选择一个通知渠道');

    const batch = validateReminderBatchInput({ ids: ['a', 'a', 'b'], action: 'delete' });
    expect(batch).toEqual({ ids: ['a', 'b'], action: 'delete' });
  });

  it('blocks private network URLs unless explicitly allowed in PrivateNetworkPolicy', () => {
    const strictPolicy = new PrivateNetworkPolicy([]);
    expect(() => parsePublicHttpUrl('http://127.0.0.1:8080', 'Bark', strictPolicy)).toThrow('本机或私有网络');
    expect(() => parsePublicHttpUrl('http://192.168.1.10:8080', 'Bark', strictPolicy)).toThrow('本机或私有网络');
    expect(() => parsePublicHttpUrl('http://localhost:8080', 'Bark', strictPolicy)).toThrow('本机或私有网络');
    expect(parsePublicHttpUrl('https://api.day.app', 'Bark', strictPolicy)).toBe('https://api.day.app/');

    const lanPolicy = new PrivateNetworkPolicy(['bark.lan', '192.168.1.0/24']);
    expect(parsePublicHttpUrl('http://bark.lan:8080', 'Bark', lanPolicy)).toBe('http://bark.lan:8080/');
    expect(parsePublicHttpUrl('http://192.168.1.42:8080', 'Bark', lanPolicy)).toBe('http://192.168.1.42:8080/');
    expect(() => parsePublicHttpUrl('http://10.0.0.5:8080', 'Bark', lanPolicy)).toThrow('本机或私有网络');

    const selfHostedPolicy = new PrivateNetworkPolicy([], true);
    expect(parsePublicHttpUrl('http://127.0.0.1:8080', 'Bark', selfHostedPolicy)).toBe('http://127.0.0.1:8080/');
    expect(parsePublicHttpUrl('http://bark-server:8080', 'Bark', selfHostedPolicy)).toBe('http://bark-server:8080/');
    expect(parsePublicHttpUrl('http://10.0.0.5:8080', 'Bark', selfHostedPolicy)).toBe('http://10.0.0.5:8080/');
  });

  it('merges Bark config cleanly and exposes plaintext deviceKey for editing', () => {
    const config = loadAppConfig({ NODE_ENV: 'test' });
    const bark = new BarkProvider(config);
    const policy = new PrivateNetworkPolicy([]);

    const created = bark.mergeConfig(
      { serverUrl: 'https://api.day.app/', deviceKey: 'secret-key-123', level: 'critical', volume: 8 },
      null,
      true,
      policy,
    );
    expect(created).toEqual({
      serverUrl: 'https://api.day.app',
      deviceKey: 'secret-key-123',
      level: 'critical',
      volume: 8,
    });

    const exposed = bark.maskConfig(created);
    expect(exposed.configured).toBe(true);
    expect(exposed.secretsSet).toEqual([]);
    expect(exposed.config?.deviceKey).toBe('secret-key-123');

    // Changing serverUrl or level while omitting deviceKey keeps existing deviceKey
    const updated = bark.mergeConfig({ serverUrl: 'https://bark.example.com', level: 'active' }, created, true, policy);
    expect(updated?.serverUrl).toBe('https://bark.example.com');
    expect(updated?.deviceKey).toBe('secret-key-123');
    expect(updated?.level).toBe('active');
  });
});
