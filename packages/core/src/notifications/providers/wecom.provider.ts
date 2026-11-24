import { z } from 'zod';
import { ValidationError } from '../../common/errors';
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
import { formatTimeLine, hostSummaryFromUrl, parseCommaList, truncateByUtf8Bytes } from '../http/message-format';
import { parsePublicHttpUrl, type PrivateNetworkPolicy } from '../http/url-policy';

export const wecomMsgTypes = ['markdown', 'markdown_v2', 'text'] as const;
export type WeComMsgType = (typeof wecomMsgTypes)[number];

export const wecomConfigSchema = z.strictObject({
  webhookUrl: z.string().min(1),
  msgType: z.enum(wecomMsgTypes).optional(),
  mentionedMobileList: z.string().max(1000).optional(),
  mentionedList: z.string().max(1000).optional(),
  mentionAll: z.boolean().optional(),
});

export type WeComConfig = z.infer<typeof wecomConfigSchema>;

const WECOM_TEXT_MAX_BYTES = 2048;
const WECOM_MARKDOWN_MAX_BYTES = 4096;
const WECOM_RETRYABLE_CODES = new Set([-1, 45009]);

export class WeComProvider implements ChannelProvider<WeComConfig> {
  readonly type = 'wecom';

  readonly meta: ChannelMeta = {
    type: 'wecom',
    name: '企业微信机器人',
    description: '企业微信群机器人 Webhook 推送（支持 Markdown 与 @提醒）',
    icon: 'chat',
    order: 3,
  };

  readonly fields: readonly ChannelField[] = [
    {
      key: 'webhookUrl',
      label: '机器人 Webhook 地址',
      group: '连接与鉴权',
      control: 'url',
      required: true,
      secret: false,
      placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...',
      help: '在企业微信群「群机器人」中复制完整 Webhook 地址，也支持自建反代地址',
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
        { label: 'Markdown v2（新版标准语法）', value: 'markdown_v2' },
        { label: '纯文本（支持 @成员 / @所有人）', value: 'text' },
      ],
    },
    {
      key: 'mentionedMobileList',
      label: '@ 手机号列表（可选）',
      group: '通知配置',
      control: 'text',
      required: false,
      secret: false,
      placeholder: '多个用逗号分隔，如 13800138000,13900139000',
      showWhen: { field: 'msgType', in: ['text'] },
    },
    {
      key: 'mentionedList',
      label: '@ UserID 列表（可选）',
      group: '通知配置',
      control: 'text',
      required: false,
      secret: false,
      placeholder: '多个用逗号分隔，如 wangqing,zhangsan',
      showWhen: { field: 'msgType', in: ['text'] },
    },
    {
      key: 'mentionAll',
      label: '@ 所有人',
      group: '通知配置',
      control: 'switch',
      required: false,
      secret: false,
      default: false,
      showWhen: { field: 'msgType', in: ['text'] },
    },
  ];

  readonly configSchema = wecomConfigSchema;

  constructor(
    private readonly policy: PrivateNetworkPolicy,
    private readonly httpPost: HttpPostFn,
  ) {}

  mergeConfig(
    rawInput: unknown,
    existing: WeComConfig | null,
    enabled: boolean,
    policy: PrivateNetworkPolicy,
  ): WeComConfig | null {
    if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
      throw new ValidationError('企业微信配置必须是 JSON 对象');
    }
    const body = rawInput as Record<string, unknown>;

    const rawUrl =
      body.webhookUrl === undefined
        ? (existing?.webhookUrl ?? '')
        : typeof body.webhookUrl === 'string'
          ? body.webhookUrl.trim()
          : '';
    if (enabled && !rawUrl) {
      throw new ValidationError('启用企业微信机器人前请填写 Webhook 地址');
    }
    if (!rawUrl) return null;

    const webhookUrl = parsePublicHttpUrl(rawUrl, '企业微信 Webhook 地址', policy);
    const config: WeComConfig = { webhookUrl };

    const msgType = body.msgType === undefined ? existing?.msgType : body.msgType;
    if (msgType !== undefined && msgType !== null && msgType !== '') {
      if (typeof msgType !== 'string' || !(wecomMsgTypes as readonly string[]).includes(msgType)) {
        throw new ValidationError('企业微信消息格式无效');
      }
      config.msgType = msgType as WeComMsgType;
    }

    const mobiles = body.mentionedMobileList === undefined ? existing?.mentionedMobileList : body.mentionedMobileList;
    if (mobiles !== undefined && mobiles !== null) {
      if (typeof mobiles !== 'string' || mobiles.trim().length > 1000) {
        throw new ValidationError('企业微信 @ 手机号列表不能超过 1000 个字符');
      }
      if (mobiles.trim()) config.mentionedMobileList = mobiles.trim();
    }

    const userIds = body.mentionedList === undefined ? existing?.mentionedList : body.mentionedList;
    if (userIds !== undefined && userIds !== null) {
      if (typeof userIds !== 'string' || userIds.trim().length > 1000) {
        throw new ValidationError('企业微信 @ UserID 列表不能超过 1000 个字符');
      }
      if (userIds.trim()) config.mentionedList = userIds.trim();
    }

    const mentionAll = body.mentionAll === undefined ? existing?.mentionAll : body.mentionAll;
    if (mentionAll !== undefined && mentionAll !== null) {
      if (typeof mentionAll !== 'boolean') throw new ValidationError('企业微信 @所有人 设置无效');
      config.mentionAll = mentionAll;
    }

    return config;
  }

  isConfigured(config: WeComConfig | null): boolean {
    return Boolean(config?.webhookUrl);
  }

  maskConfig(config: WeComConfig | null): MaskedChannelConfig {
    if (!config) {
      return { config: null, secretsSet: [], configured: false, summary: [] };
    }
    const msgType = config.msgType ?? 'markdown';
    const summary: ChannelSummaryItem[] = [
      { label: '网关', value: hostSummaryFromUrl(config.webhookUrl) },
      {
        label: '配置',
        value: [
          msgType,
          msgType === 'text' && config.mentionAll ? '@所有人' : '',
          msgType === 'text' && (config.mentionedMobileList || config.mentionedList) ? '@指定成员' : '',
        ]
          .filter(Boolean)
          .join(' · '),
      },
    ];
    return {
      config: { msgType: 'markdown', ...config },
      secretsSet: [],
      configured: this.isConfigured(config),
      summary,
    };
  }

  async send(
    message: NotificationMessage,
    config: WeComConfig,
    options?: NotificationSendOptions,
  ): Promise<NotificationResult> {
    try {
      const msgType = config.msgType ?? 'markdown';
      const timeLine = formatTimeLine(message);

      let payload: Record<string, unknown>;
      if (msgType === 'text') {
        const rawText = [message.title, message.content, timeLine].filter(Boolean).join('\n\n');
        const content = truncateByUtf8Bytes(rawText, WECOM_TEXT_MAX_BYTES);
        const mentionedList = parseCommaList(config.mentionedList);
        if (config.mentionAll && !mentionedList.includes('@all')) {
          mentionedList.push('@all');
        }
        const mentionedMobileList = parseCommaList(config.mentionedMobileList);
        payload = {
          msgtype: 'text',
          text: {
            content,
            ...(mentionedList.length ? { mentioned_list: mentionedList } : {}),
            ...(mentionedMobileList.length ? { mentioned_mobile_list: mentionedMobileList } : {}),
          },
        };
      } else {
        const rawMd = [`### ${message.title}`, message.content, `> ${timeLine}`].filter(Boolean).join('\n\n');
        const content = truncateByUtf8Bytes(rawMd, WECOM_MARKDOWN_MAX_BYTES);
        payload =
          msgType === 'markdown_v2'
            ? { msgtype: 'markdown_v2', markdown_v2: { content } }
            : { msgtype: 'markdown', markdown: { content } };
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
          return { ok: false, error: '企业微信返回格式无效', errorClass: 'permanent' };
        }
        const parsed = body as { errcode?: unknown; errmsg?: unknown };
        if (parsed.errcode === 0) return { ok: true, error: null };
        const code = typeof parsed.errcode === 'number' ? parsed.errcode : -999;
        return {
          ok: false,
          error:
            typeof parsed.errmsg === 'string' && parsed.errmsg
              ? `企业微信错误(${code})：${parsed.errmsg}`
              : `企业微信发送失败(${code})`,
          errorClass: WECOM_RETRYABLE_CODES.has(code) ? 'retryable' : 'permanent',
        };
      });
    } catch (error) {
      return resultFromError(error);
    }
  }
}
