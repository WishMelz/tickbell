import * as crypto from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';
import { ValidationError } from '../../../common/errors';
import { APP_CONFIG, type AppConfig } from '../../../config/app-config';
import {
  type ChannelField,
  type ChannelMeta,
  type ChannelProvider,
  type ChannelSummaryItem,
  type MaskedChannelConfig,
  NOTIFICATION_HTTP_POST,
  type NotificationMessage,
  type NotificationResult,
} from '../channel-provider.interface';
import {
  ensureKeyword,
  formatTimeLine,
  hostSummaryFromUrl,
  parseCommaList,
  truncateByUtf8Bytes,
} from '../http/message-format';
import {
  type HttpPostFn,
  pinnedHttpPost,
  resultFromError,
  resultFromHttpResponse,
} from '../http/pinned-fetch';
import { parsePublicHttpUrl, PrivateNetworkPolicy } from '../http/url-policy';

export const dingtalkMsgTypes = ['markdown', 'text'] as const;
export type DingTalkMsgType = (typeof dingtalkMsgTypes)[number];

export const dingtalkConfigSchema = z.strictObject({
  webhookUrl: z.string().min(1),
  secret: z.string().max(256).optional(),
  keyword: z.string().max(64).optional(),
  msgType: z.enum(dingtalkMsgTypes).optional(),
  atMobiles: z.string().max(1000).optional(),
  atUserIds: z.string().max(1000).optional(),
  isAtAll: z.boolean().optional(),
});

export type DingTalkConfig = z.infer<typeof dingtalkConfigSchema>;

const DINGTALK_CONTENT_MAX_BYTES = 18 * 1024;
const DINGTALK_RETRYABLE_CODES = new Set([-1, 45009, 130101]);

/** Official DingTalk custom robot signing algorithm: timestamp (ms) + "\n" + secret -> HMAC-SHA256 -> Base64 -> URL-encoded. */
export function signDingTalkUrl(rawUrl: string, secret: string, timestampMs = Date.now()): string {
  const timestamp = String(timestampMs);
  const stringToSign = `${timestamp}\n${secret}`;
  const signature = crypto.createHmac('sha256', secret).update(stringToSign, 'utf8').digest('base64');
  const url = new URL(rawUrl);
  url.searchParams.set('timestamp', timestamp);
  url.searchParams.set('sign', signature);
  return url.toString();
}

@Injectable()
export class DingTalkProvider implements ChannelProvider<DingTalkConfig> {
  readonly type = 'dingtalk';

  readonly meta: ChannelMeta = {
    type: 'dingtalk',
    name: '钉钉机器人',
    description: '钉钉群自定义机器人推送（支持加签、自定义关键词、Markdown 与 @提醒）',
    icon: 'campaign',
    order: 4,
  };

  readonly fields: readonly ChannelField[] = [
    {
      key: 'webhookUrl',
      label: '机器人 Webhook 地址',
      group: '连接与鉴权',
      control: 'url',
      required: true,
      secret: false,
      placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=...',
      help: '在钉钉群「群设置 → 智能群助手 → 自定义机器人」中复制 Webhook 地址',
    },
    {
      key: 'secret',
      label: '加签密钥（Secret，可选）',
      group: '连接与鉴权',
      control: 'text',
      required: false,
      secret: false,
      placeholder: 'SEC...',
      help: '机器人安全设置勾选「加签」时填写，发送时自动计算 timestamp 与 sign',
    },
    {
      key: 'keyword',
      label: '自定义关键词（可选）',
      group: '连接与鉴权',
      control: 'text',
      required: false,
      secret: false,
      placeholder: '例如：提醒',
      help: '安全设置使用「自定义关键词」时填写；消息不含该词时自动加在标题前',
    },
    {
      key: 'msgType',
      label: '消息格式',
      group: '通知配置',
      control: 'select',
      required: false,
      secret: false,
      default: 'markdown',
      options: [
        { label: 'Markdown（推荐）', value: 'markdown' },
        { label: '纯文本', value: 'text' },
      ],
    },
    {
      key: 'atMobiles',
      label: '@ 手机号列表（可选）',
      group: '通知配置',
      control: 'text',
      required: false,
      secret: false,
      placeholder: '多个用逗号分隔，如 13800138000,13900139000',
    },
    {
      key: 'atUserIds',
      label: '@ UserID 列表（可选）',
      group: '通知配置',
      control: 'text',
      required: false,
      secret: false,
      placeholder: '多个用逗号分隔',
    },
    {
      key: 'isAtAll',
      label: '@ 所有人',
      group: '通知配置',
      control: 'switch',
      required: false,
      secret: false,
      default: false,
    },
  ];

  readonly configSchema = dingtalkConfigSchema;

  private readonly policy: PrivateNetworkPolicy;
  private readonly httpPost: HttpPostFn;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Optional() @Inject(NOTIFICATION_HTTP_POST) httpPost?: HttpPostFn,
  ) {
    this.policy = new PrivateNetworkPolicy(config.allowedPrivateHosts, config.allowPrivateUrls);
    this.httpPost = httpPost ?? pinnedHttpPost;
  }

  mergeConfig(
    rawInput: unknown,
    existing: DingTalkConfig | null,
    enabled: boolean,
    policy: PrivateNetworkPolicy,
  ): DingTalkConfig | null {
    if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
      throw new ValidationError('钉钉配置必须是 JSON 对象');
    }
    const body = rawInput as Record<string, unknown>;

    const rawUrl =
      body.webhookUrl === undefined
        ? (existing?.webhookUrl ?? '')
        : typeof body.webhookUrl === 'string'
          ? body.webhookUrl.trim()
          : '';
    if (enabled && !rawUrl) {
      throw new ValidationError('启用钉钉机器人前请填写 Webhook 地址');
    }
    if (!rawUrl) return null;

    const webhookUrl = parsePublicHttpUrl(rawUrl, '钉钉 Webhook 地址', policy);
    const config: DingTalkConfig = { webhookUrl };

    const secret = body.secret === undefined ? existing?.secret : body.secret;
    if (secret !== undefined && secret !== null) {
      if (typeof secret !== 'string' || secret.trim().length > 256) {
        throw new ValidationError('钉钉加签密钥不能超过 256 个字符');
      }
      if (secret.trim()) config.secret = secret.trim();
    }

    const keyword = body.keyword === undefined ? existing?.keyword : body.keyword;
    if (keyword !== undefined && keyword !== null) {
      if (typeof keyword !== 'string' || keyword.trim().length > 64) {
        throw new ValidationError('钉钉关键词不能超过 64 个字符');
      }
      if (keyword.trim()) config.keyword = keyword.trim();
    }

    const msgType = body.msgType === undefined ? existing?.msgType : body.msgType;
    if (msgType !== undefined && msgType !== null && msgType !== '') {
      if (typeof msgType !== 'string' || !(dingtalkMsgTypes as readonly string[]).includes(msgType)) {
        throw new ValidationError('钉钉消息格式无效');
      }
      config.msgType = msgType as DingTalkMsgType;
    }

    const atMobiles = body.atMobiles === undefined ? existing?.atMobiles : body.atMobiles;
    if (atMobiles !== undefined && atMobiles !== null) {
      if (typeof atMobiles !== 'string' || atMobiles.trim().length > 1000) {
        throw new ValidationError('钉钉 @ 手机号列表不能超过 1000 个字符');
      }
      if (atMobiles.trim()) config.atMobiles = atMobiles.trim();
    }

    const atUserIds = body.atUserIds === undefined ? existing?.atUserIds : body.atUserIds;
    if (atUserIds !== undefined && atUserIds !== null) {
      if (typeof atUserIds !== 'string' || atUserIds.trim().length > 1000) {
        throw new ValidationError('钉钉 @ UserID 列表不能超过 1000 个字符');
      }
      if (atUserIds.trim()) config.atUserIds = atUserIds.trim();
    }

    const isAtAll = body.isAtAll === undefined ? existing?.isAtAll : body.isAtAll;
    if (isAtAll !== undefined && isAtAll !== null) {
      if (typeof isAtAll !== 'boolean') throw new ValidationError('钉钉 @所有人 设置无效');
      config.isAtAll = isAtAll;
    }

    return config;
  }

  isConfigured(config: DingTalkConfig | null): boolean {
    return Boolean(config?.webhookUrl);
  }

  maskConfig(config: DingTalkConfig | null): MaskedChannelConfig {
    if (!config) {
      return { config: null, secretsSet: [], configured: false, summary: [] };
    }
    const security = [config.secret ? '加签' : '', config.keyword ? `关键词：${config.keyword}` : ''].filter(Boolean);
    const summary: ChannelSummaryItem[] = [
      { label: '网关', value: hostSummaryFromUrl(config.webhookUrl) },
      {
        label: '配置',
        value: [config.msgType ?? 'markdown', security.length ? security.join(' + ') : '无附加校验'].join(' · '),
      },
    ];
    return {
      config: { msgType: 'markdown', ...config },
      secretsSet: [],
      configured: this.isConfigured(config),
      summary,
    };
  }

  async send(message: NotificationMessage, config: DingTalkConfig): Promise<NotificationResult> {
    try {
      const targetUrl = config.secret ? signDingTalkUrl(config.webhookUrl, config.secret) : config.webhookUrl;
      const safeContent = truncateByUtf8Bytes(message.content, DINGTALK_CONTENT_MAX_BYTES);
      const { title, content } = ensureKeyword(message.title, safeContent, config.keyword);
      const timeLine = formatTimeLine(message);
      const atMobiles = parseCommaList(config.atMobiles);
      const atUserIds = parseCommaList(config.atUserIds);
      const at = {
        ...(atMobiles.length ? { atMobiles } : {}),
        ...(atUserIds.length ? { atUserIds } : {}),
        isAtAll: Boolean(config.isAtAll),
      };

      const msgType = config.msgType ?? 'markdown';
      let payload: Record<string, unknown>;
      if (msgType === 'text') {
        payload = {
          msgtype: 'text',
          text: {
            content: [title, content, timeLine].filter(Boolean).join('\n\n'),
          },
          at,
        };
      } else {
        // DingTalk requires @mobile and @userId mentions to appear in markdown text for client highlighting
        const mentionLine = [...atMobiles, ...atUserIds].map((id) => `@${id}`).join(' ');
        const text = [`### ${title}`, content, `> ${timeLine}`, mentionLine].filter(Boolean).join('\n\n');
        payload = {
          msgtype: 'markdown',
          markdown: { title, text },
          at,
        };
      }

      const response = await this.httpPost({
        url: targetUrl,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeoutMs: 15_000,
        policy: this.policy,
      });

      return resultFromHttpResponse(response, (body) => {
        if (!body || typeof body !== 'object') {
          return { ok: false, error: '钉钉返回格式无效', errorClass: 'permanent' };
        }
        const parsed = body as { errcode?: unknown; errmsg?: unknown };
        if (parsed.errcode === 0) return { ok: true, error: null };
        const code = typeof parsed.errcode === 'number' ? parsed.errcode : -999;
        return {
          ok: false,
          error:
            typeof parsed.errmsg === 'string' && parsed.errmsg
              ? `钉钉错误(${code})：${parsed.errmsg}`
              : `钉钉发送失败(${code})`,
          errorClass: DINGTALK_RETRYABLE_CODES.has(code) ? 'retryable' : 'permanent',
        };
      });
    } catch (error) {
      return resultFromError(error);
    }
  }
}
