import { z } from 'zod';
import { ValidationError } from '../../common/errors';
import { hmacSha256Base64 } from '../../crypto/index';
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
import { ensureKeyword, formatTimeLine, hostSummaryFromUrl, truncateByUtf8Bytes } from '../http/message-format';
import { parsePublicHttpUrl, type PrivateNetworkPolicy } from '../http/url-policy';

export const feishuMsgTypes = ['interactive', 'text'] as const;
export type FeishuMsgType = (typeof feishuMsgTypes)[number];

export const feishuCardColors = ['blue', 'turquoise', 'green', 'orange', 'red', 'indigo'] as const;
export type FeishuCardColor = (typeof feishuCardColors)[number];

export const feishuConfigSchema = z.strictObject({
  webhookUrl: z.string().min(1),
  secret: z.string().max(256).optional(),
  keyword: z.string().max(64).optional(),
  msgType: z.enum(feishuMsgTypes).optional(),
  cardHeaderColor: z.enum(feishuCardColors).optional(),
  mentionAll: z.boolean().optional(),
});

export type FeishuConfig = z.infer<typeof feishuConfigSchema>;

const FEISHU_CONTENT_MAX_BYTES = 18 * 1024;
const FEISHU_RETRYABLE_CODES = new Set([9499, 11232]);

export async function computeFeishuSignature(secret: string, timestampSeconds: string): Promise<string> {
  const stringToSign = `${timestampSeconds}\n${secret}`;
  return hmacSha256Base64(stringToSign, new Uint8Array(0));
}

export class FeishuProvider implements ChannelProvider<FeishuConfig> {
  readonly type = 'feishu';

  readonly meta: ChannelMeta = {
    type: 'feishu',
    name: '飞书机器人',
    description: '飞书 / Lark 群自定义机器人推送（支持签名校验与彩色消息卡片）',
    icon: 'notifications_active',
    order: 5,
  };

  readonly fields: readonly ChannelField[] = [
    {
      key: 'webhookUrl',
      label: '机器人 Webhook 地址',
      group: '连接与鉴权',
      control: 'url',
      required: true,
      secret: false,
      placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/...',
      help: '支持飞书国内版（open.feishu.cn）与 Lark 国际版（open.larksuite.com）',
    },
    {
      key: 'secret',
      label: '签名校验密钥（Secret，可选）',
      group: '连接与鉴权',
      control: 'text',
      required: false,
      secret: false,
      help: '机器人安全设置开启「签名校验」时填写，发送时自动注入 timestamp 与 sign',
    },
    {
      key: 'keyword',
      label: '自定义关键词（可选）',
      group: '连接与鉴权',
      control: 'text',
      required: false,
      secret: false,
      placeholder: '例如：提醒',
      help: '开启「自定义关键词」时填写；消息不含该词时自动加在标题前',
    },
    {
      key: 'msgType',
      label: '消息形态',
      group: '通知配置',
      control: 'select',
      required: false,
      secret: false,
      default: 'interactive',
      options: [
        { label: '消息卡片（推荐）', value: 'interactive' },
        { label: '纯文本', value: 'text' },
      ],
    },
    {
      key: 'cardHeaderColor',
      label: '卡片标题栏颜色',
      group: '通知配置',
      control: 'select',
      required: false,
      secret: false,
      default: 'blue',
      showWhen: { field: 'msgType', in: ['interactive'] },
      options: [
        { label: '蓝色', value: 'blue' },
        { label: '青色', value: 'turquoise' },
        { label: '绿色', value: 'green' },
        { label: '橙色', value: 'orange' },
        { label: '红色', value: 'red' },
        { label: '靛蓝', value: 'indigo' },
      ],
    },
    {
      key: 'mentionAll',
      label: '@ 所有人',
      group: '通知配置',
      control: 'switch',
      required: false,
      secret: false,
      default: false,
    },
  ];

  readonly configSchema = feishuConfigSchema;

  constructor(
    private readonly policy: PrivateNetworkPolicy,
    private readonly httpPost: HttpPostFn,
  ) {}

  mergeConfig(
    rawInput: unknown,
    existing: FeishuConfig | null,
    enabled: boolean,
    policy: PrivateNetworkPolicy,
  ): FeishuConfig | null {
    if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
      throw new ValidationError('飞书配置必须是 JSON 对象');
    }
    const body = rawInput as Record<string, unknown>;

    const rawUrl =
      body.webhookUrl === undefined
        ? (existing?.webhookUrl ?? '')
        : typeof body.webhookUrl === 'string'
          ? body.webhookUrl.trim()
          : '';
    if (enabled && !rawUrl) {
      throw new ValidationError('启用飞书机器人前请填写 Webhook 地址');
    }
    if (!rawUrl) return null;

    const webhookUrl = parsePublicHttpUrl(rawUrl, '飞书 Webhook 地址', policy);
    const config: FeishuConfig = { webhookUrl };

    const secret = body.secret === undefined ? existing?.secret : body.secret;
    if (secret !== undefined && secret !== null) {
      if (typeof secret !== 'string' || secret.trim().length > 256) {
        throw new ValidationError('飞书签名密钥不能超过 256 个字符');
      }
      if (secret.trim()) config.secret = secret.trim();
    }

    const keyword = body.keyword === undefined ? existing?.keyword : body.keyword;
    if (keyword !== undefined && keyword !== null) {
      if (typeof keyword !== 'string' || keyword.trim().length > 64) {
        throw new ValidationError('飞书关键词不能超过 64 个字符');
      }
      if (keyword.trim()) config.keyword = keyword.trim();
    }

    const msgType = body.msgType === undefined ? existing?.msgType : body.msgType;
    if (msgType !== undefined && msgType !== null && msgType !== '') {
      if (typeof msgType !== 'string' || !(feishuMsgTypes as readonly string[]).includes(msgType)) {
        throw new ValidationError('飞书消息形态无效');
      }
      config.msgType = msgType as FeishuMsgType;
    }

    const cardHeaderColor = body.cardHeaderColor === undefined ? existing?.cardHeaderColor : body.cardHeaderColor;
    if (cardHeaderColor !== undefined && cardHeaderColor !== null && cardHeaderColor !== '') {
      if (typeof cardHeaderColor !== 'string' || !(feishuCardColors as readonly string[]).includes(cardHeaderColor)) {
        throw new ValidationError('飞书卡片颜色无效');
      }
      config.cardHeaderColor = cardHeaderColor as FeishuCardColor;
    }

    const mentionAll = body.mentionAll === undefined ? existing?.mentionAll : body.mentionAll;
    if (mentionAll !== undefined && mentionAll !== null) {
      if (typeof mentionAll !== 'boolean') throw new ValidationError('飞书 @所有人 设置无效');
      config.mentionAll = mentionAll;
    }

    return config;
  }

  isConfigured(config: FeishuConfig | null): boolean {
    return Boolean(config?.webhookUrl);
  }

  maskConfig(config: FeishuConfig | null): MaskedChannelConfig {
    if (!config) {
      return { config: null, secretsSet: [], configured: false, summary: [] };
    }
    const security = [config.secret ? '签名校验' : '', config.keyword ? `关键词：${config.keyword}` : ''].filter(
      Boolean,
    );
    const summary: ChannelSummaryItem[] = [
      { label: '网关', value: hostSummaryFromUrl(config.webhookUrl) },
      {
        label: '配置',
        value: [
          config.msgType === 'text' ? '纯文本' : '消息卡片',
          security.length ? security.join(' + ') : '无附加校验',
        ].join(' · '),
      },
    ];
    return {
      config: { msgType: 'interactive', cardHeaderColor: 'blue', ...config },
      secretsSet: [],
      configured: this.isConfigured(config),
      summary,
    };
  }

  async send(
    message: NotificationMessage,
    config: FeishuConfig,
    options?: NotificationSendOptions,
  ): Promise<NotificationResult> {
    try {
      const safeContent = truncateByUtf8Bytes(message.content, FEISHU_CONTENT_MAX_BYTES);
      const { title, content } = ensureKeyword(message.title, safeContent, config.keyword);
      const timeLine = formatTimeLine(message);
      const msgType = config.msgType ?? 'interactive';

      const payload: Record<string, unknown> = {};
      if (config.secret) {
        const timestamp = String(Math.floor(Date.now() / 1000));
        payload.timestamp = timestamp;
        payload.sign = await computeFeishuSignature(config.secret, timestamp);
      }

      if (msgType === 'text') {
        const mention = config.mentionAll ? '<at user_id="all">所有人</at> ' : '';
        payload.msg_type = 'text';
        payload.content = {
          text: `${mention}${[title, content, timeLine].filter(Boolean).join('\n\n')}`,
        };
      } else {
        const bodyMd = [config.mentionAll ? '<at id=all></at>' : '', content].filter(Boolean).join('\n');
        const elements: Array<Record<string, unknown>> = [];
        if (bodyMd) {
          elements.push({ tag: 'markdown', content: bodyMd });
        }
        elements.push({
          tag: 'note',
          elements: [{ tag: 'plain_text', content: timeLine }],
        });
        payload.msg_type = 'interactive';
        payload.card = {
          config: { wide_screen_mode: true },
          header: {
            title: { tag: 'plain_text', content: title },
            template: message.isLate ? 'orange' : (config.cardHeaderColor ?? 'blue'),
          },
          elements,
        };
      }

      const response = await this.httpPost({
        url: config.webhookUrl,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeoutMs: 15_000,
        policy: this.policy,
        proxy: options?.proxy,
      });

      return resultFromHttpResponse(response, (body) => {
        if (!body || typeof body !== 'object') {
          return { ok: false, error: '飞书返回格式无效', errorClass: 'permanent' };
        }
        const parsed = body as { code?: unknown; msg?: unknown; StatusCode?: unknown; StatusMessage?: unknown };
        if (parsed.code === 0 || parsed.StatusCode === 0) {
          return { ok: true, error: null };
        }
        const code =
          typeof parsed.code === 'number'
            ? parsed.code
            : typeof parsed.StatusCode === 'number'
              ? parsed.StatusCode
              : -999;
        const msg =
          (typeof parsed.msg === 'string' && parsed.msg)
          || (typeof parsed.StatusMessage === 'string' && parsed.StatusMessage)
          || `飞书发送失败(${code})`;
        return {
          ok: false,
          error: `飞书错误(${code})：${msg}`,
          errorClass: FEISHU_RETRYABLE_CODES.has(code) ? 'retryable' : 'permanent',
        };
      });
    } catch (error) {
      return resultFromError(error);
    }
  }
}
