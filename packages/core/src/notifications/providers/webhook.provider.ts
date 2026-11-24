import { z } from 'zod';
import { ValidationError } from '../../common/errors';
import { epochToIso, epochToLocalInput } from '../../common/time';
import { hmacSha256Hex } from '../../crypto/index';
import type { HttpPostFn } from '../../ports/index';
import type {
  ChannelField,
  ChannelMeta,
  ChannelProvider,
  ChannelSummaryItem,
  MaskedChannelConfig,
  NotificationMessage,
  NotificationResult,
  NotificationSendOptions,
} from '../channel-provider.interface';
import { resultFromError, resultFromHttpResponse } from '../http/http-helpers';
import { hostSummaryFromUrl } from '../http/message-format';
import { parsePublicHttpUrl, type PrivateNetworkPolicy } from '../http/url-policy';

export const webhookMethods = ['POST', 'PUT'] as const;
export type WebhookMethod = (typeof webhookMethods)[number];

export const webhookConfigSchema = z.strictObject({
  url: z.string().min(1),
  method: z.enum(webhookMethods).optional(),
  secret: z.string().max(256).optional(),
  headersText: z.string().max(4000).optional(),
  bodyTemplate: z.string().max(16000).optional(),
});

export type WebhookConfig = z.infer<typeof webhookConfigSchema>;

const FORBIDDEN_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'x-reminder-event-id',
  'x-reminder-timestamp',
  'x-reminder-signature',
]);
const HEADER_NAME_RE = /^[A-Za-z0-9-]+$/;

export function parseCustomHeaders(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  const headers: Record<string, string> = {};
  const seenLower = new Map<string, string>();
  const lines = raw.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) {
      throw new ValidationError(`自定义请求头格式无效（应为 Header-Name: value）：${line}`);
    }
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!HEADER_NAME_RE.test(name)) {
      throw new ValidationError(`自定义请求头名称无效：${name}`);
    }
    const lower = name.toLowerCase();
    if (FORBIDDEN_HEADERS.has(lower)) {
      throw new ValidationError(`不允许自定义系统保留请求头：${name}`);
    }
    if (/[\r\n]/.test(value)) {
      throw new ValidationError(`请求头 ${name} 的值不能包含换行符`);
    }
    const prevKey = seenLower.get(lower);
    if (prevKey && prevKey !== name) {
      delete headers[prevKey];
    }
    seenLower.set(lower, name);
    headers[name] = value;
    if (seenLower.size > 20) {
      throw new ValidationError('自定义请求头最多配置 20 条');
    }
  }
  return headers;
}

function escapeJsonString(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

export function renderWebhookTemplate(template: string, message: NotificationMessage): string {
  const vars: Record<string, string> = {
    title: escapeJsonString(message.title),
    content: escapeJsonString(message.content),
    scheduledAt: escapeJsonString(epochToIso(message.scheduledAt)),
    scheduledLocal: escapeJsonString(epochToLocalInput(message.scheduledAt, message.timezone)),
    triggeredAt: escapeJsonString(epochToIso(message.triggeredAt)),
    timezone: escapeJsonString(message.timezone),
    eventId: escapeJsonString(message.eventId),
    reminderId: escapeJsonString(message.reminderId),
    isLate: message.isLate ? 'true' : 'false',
    isTest: message.isTest ? 'true' : 'false',
  };
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (full, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : full,
  );
}

export class WebhookProvider implements ChannelProvider<WebhookConfig> {
  readonly type = 'webhook';

  readonly meta: ChannelMeta = {
    type: 'webhook',
    name: '通用 Webhook',
    description: '自定义 HTTP JSON 推送（支持 HMAC 签名、自定义请求头与 JSON 模板）',
    icon: 'webhook',
    order: 7,
  };

  readonly fields: readonly ChannelField[] = [
    {
      key: 'url',
      label: 'Webhook 地址',
      group: '连接与鉴权',
      control: 'url',
      required: true,
      secret: false,
      placeholder: 'https://example.com/hooks/reminder',
      help: '支持公网 HTTP(S) 接口（自部署模式也支持内网/局域网接口）',
    },
    {
      key: 'method',
      label: 'HTTP 方法',
      group: '连接与鉴权',
      control: 'select',
      required: false,
      secret: false,
      default: 'POST',
      options: [
        { label: 'POST', value: 'POST' },
        { label: 'PUT', value: 'PUT' },
      ],
    },
    {
      key: 'secret',
      label: 'HMAC 签名密钥（可选）',
      group: '连接与鉴权',
      control: 'text',
      required: false,
      secret: false,
      help: '填写后自动附带 X-Reminder-Timestamp 与 X-Reminder-Signature: sha256=HMAC(secret, timestamp.body)',
    },
    {
      key: 'headersText',
      label: '自定义请求头（可选）',
      group: '连接与鉴权',
      control: 'textarea',
      required: false,
      secret: false,
      placeholder: 'Authorization: Bearer your-token\nX-App-Source: tickbell',
      help: '每行一条，格式为 Header-Name: value，最多 20 条',
    },
    {
      key: 'bodyTemplate',
      label: '自定义 JSON 模板（可选）',
      group: '通知配置',
      control: 'textarea',
      required: false,
      secret: false,
      placeholder: '{"text": "{{title}}\\n{{content}}"}',
      help: '留空发送标准 JSON；支持占位符 {{title}}、{{content}}、{{scheduledAt}}、{{scheduledLocal}}、{{triggeredAt}}、{{timezone}}、{{eventId}}、{{reminderId}}、{{isLate}}、{{isTest}}',
    },
  ];

  readonly configSchema = webhookConfigSchema;

  constructor(
    private readonly policy: PrivateNetworkPolicy,
    private readonly httpPost: HttpPostFn,
  ) {}

  mergeConfig(
    rawInput: unknown,
    existing: WebhookConfig | null,
    enabled: boolean,
    policy: PrivateNetworkPolicy,
  ): WebhookConfig | null {
    if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
      throw new ValidationError('Webhook 配置必须是 JSON 对象');
    }
    const body = rawInput as Record<string, unknown>;

    const rawUrl =
      body.url === undefined
        ? (existing?.url ?? '')
        : typeof body.url === 'string'
          ? body.url.trim()
          : '';
    if (enabled && !rawUrl) {
      throw new ValidationError('启用 Webhook 前请填写目标 URL');
    }
    if (!rawUrl) return null;

    const url = parsePublicHttpUrl(rawUrl, 'Webhook URL', policy);
    const config: WebhookConfig = { url };

    const method = body.method === undefined ? existing?.method : body.method;
    if (method !== undefined && method !== null && method !== '') {
      if (typeof method !== 'string' || !(webhookMethods as readonly string[]).includes(method)) {
        throw new ValidationError('Webhook HTTP 方法仅支持 POST 或 PUT');
      }
      config.method = method as WebhookMethod;
    }

    const secret = body.secret === undefined ? existing?.secret : body.secret;
    if (secret !== undefined && secret !== null) {
      if (typeof secret !== 'string' || secret.trim().length > 256) {
        throw new ValidationError('Webhook 签名密钥不能超过 256 个字符');
      }
      if (secret.trim()) config.secret = secret.trim();
    }

    const headersText = body.headersText === undefined ? existing?.headersText : body.headersText;
    if (headersText !== undefined && headersText !== null) {
      if (typeof headersText !== 'string' || headersText.length > 4000) {
        throw new ValidationError('自定义请求头长度不能超过 4000 个字符');
      }
      if (headersText.trim()) {
        parseCustomHeaders(headersText);
        config.headersText = headersText.trim();
      }
    }

    const bodyTemplate = body.bodyTemplate === undefined ? existing?.bodyTemplate : body.bodyTemplate;
    if (bodyTemplate !== undefined && bodyTemplate !== null) {
      if (typeof bodyTemplate !== 'string' || bodyTemplate.length > 16000) {
        throw new ValidationError('自定义 JSON 模板长度不能超过 16000 个字符');
      }
      if (bodyTemplate.trim()) {
        const sampleRendered = renderWebhookTemplate(bodyTemplate.trim(), {
          eventId: 'sample-event',
          reminderId: 'sample-reminder',
          title: 'Sample "Title"',
          content: 'Line 1\nLine 2',
          timezone: 'UTC',
          scheduledAt: Date.UTC(2026, 0, 1, 0, 0, 0),
          triggeredAt: Date.UTC(2026, 0, 1, 0, 0, 0),
          isLate: false,
        });
        try {
          JSON.parse(sampleRendered);
        } catch {
          throw new ValidationError('自定义模板渲染后不是合法的 JSON，请检查引号和语法');
        }
        config.bodyTemplate = bodyTemplate.trim();
      }
    }

    return config;
  }

  isConfigured(config: WebhookConfig | null): boolean {
    return Boolean(config?.url);
  }

  maskConfig(config: WebhookConfig | null): MaskedChannelConfig {
    if (!config) {
      return { config: null, secretsSet: [], configured: false, summary: [] };
    }
    const summary: ChannelSummaryItem[] = [
      { label: '目标', value: `${config.method ?? 'POST'} ${hostSummaryFromUrl(config.url)}` },
    ];
    const flags = [
      config.secret ? '已开启 HMAC 签名' : '',
      config.headersText ? '含自定义请求头' : '',
      config.bodyTemplate ? '自定义模板' : '标准 JSON',
    ].filter(Boolean);
    if (flags.length) summary.push({ label: '配置', value: flags.join(' · ') });

    return {
      config: { method: 'POST', ...config },
      secretsSet: [],
      configured: this.isConfigured(config),
      summary,
    };
  }

  async send(
    message: NotificationMessage,
    config: WebhookConfig,
    options?: NotificationSendOptions,
  ): Promise<NotificationResult> {
    try {
      const payload = config.bodyTemplate
        ? renderWebhookTemplate(config.bodyTemplate, message)
        : JSON.stringify({
            event: 'reminder.triggered',
            event_id: message.eventId,
            reminder: {
              id: message.reminderId,
              title: message.title,
              content: message.content,
            },
            scheduled_at: epochToIso(message.scheduledAt),
            triggered_at: epochToIso(message.triggeredAt),
            timezone: message.timezone,
            is_late: Boolean(message.isLate),
            is_test: Boolean(message.isTest),
          });

      const customHeaders = parseCustomHeaders(config.headersText);
      const hasCustomContentType = Object.keys(customHeaders).some((k) => k.toLowerCase() === 'content-type');
      const headers: Record<string, string> = {
        ...(hasCustomContentType ? {} : { 'Content-Type': 'application/json' }),
        ...customHeaders,
        'X-Reminder-Event-Id': message.eventId,
      };

      if (config.secret) {
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = await hmacSha256Hex(config.secret, `${timestamp}.${payload}`);
        headers['X-Reminder-Timestamp'] = timestamp;
        headers['X-Reminder-Signature'] = `sha256=${signature}`;
      }

      const response = await this.httpPost({
        url: config.url,
        method: config.method ?? 'POST',
        headers,
        body: payload,
        timeoutMs: 15_000,
        policy: this.policy,
        proxy: options?.proxy,
      });

      return resultFromHttpResponse(response);
    } catch (error) {
      return resultFromError(error);
    }
  }
}
