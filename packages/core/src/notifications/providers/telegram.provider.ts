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
import { classifyHttpStatus, resultFromError, resultFromHttpResponse } from '../http/http-helpers';
import {
  contentHtmlToTelegramHtml,
  escapeAndTruncateHtml,
  escapeHtml,
  formatTimeLine,
  hostSummaryFromUrl,
  truncateByChars,
} from '../http/message-format';
import { parsePublicHttpUrl, type PrivateNetworkPolicy } from '../http/url-policy';

export const telegramParseModes = ['none', 'HTML'] as const;
export type TelegramParseMode = (typeof telegramParseModes)[number];

export const telegramConfigSchema = z.strictObject({
  apiBaseUrl: z.string().min(1).optional(),
  botToken: z.string(),
  chatId: z.string(),
  messageThreadId: z.number().int().min(1).optional(),
  parseMode: z.enum(telegramParseModes).optional(),
  disableNotification: z.boolean().optional(),
  disableWebPagePreview: z.boolean().optional(),
  protectContent: z.boolean().optional(),
});

export type TelegramConfig = z.infer<typeof telegramConfigSchema>;

const DEFAULT_API_BASE = 'https://api.telegram.org';
const BOT_TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]{20,}$/;
const TELEGRAM_TEXT_LIMIT = 4096;

export class TelegramProvider implements ChannelProvider<TelegramConfig> {
  readonly type = 'telegram';

  readonly meta: ChannelMeta = {
    type: 'telegram',
    name: 'Telegram Bot',
    description: 'Telegram 机器人推送（支持官方 API 或自建反代地址）',
    icon: 'send',
    order: 2,
  };

  readonly fields: readonly ChannelField[] = [
    {
      key: 'apiBaseUrl',
      label: 'Bot API 地址',
      group: '连接与鉴权',
      control: 'url',
      required: false,
      secret: false,
      default: DEFAULT_API_BASE,
      placeholder: 'https://api.telegram.org',
      help: '留空使用官方地址；国内环境可填写自建反代或 Local Bot API Server 地址',
    },
    {
      key: 'botToken',
      label: 'Bot Token',
      group: '连接与鉴权',
      control: 'text',
      required: true,
      secret: false,
      placeholder: '123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      help: '通过 @BotFather 创建机器人后获取的 Token',
    },
    {
      key: 'chatId',
      label: 'Chat ID',
      group: '连接与鉴权',
      control: 'text',
      required: true,
      secret: false,
      placeholder: '个人 ID、群组负 ID（-100...）或 @channel',
    },
    {
      key: 'messageThreadId',
      label: '话题 ID（Topic Thread ID，可选）',
      group: '通知配置',
      control: 'number',
      required: false,
      secret: false,
      min: 1,
      help: '开启话题功能的超级群组可指定推送到某个 Topic',
    },
    {
      key: 'parseMode',
      label: '消息格式',
      group: '通知配置',
      control: 'select',
      required: false,
      secret: false,
      default: 'none',
      options: [
        { label: '纯文本', value: 'none' },
        { label: 'HTML 富文本', value: 'HTML' },
      ],
    },
    {
      key: 'disableNotification',
      label: '静默发送（不响铃）',
      group: '通知配置',
      control: 'switch',
      required: false,
      secret: false,
      default: false,
    },
    {
      key: 'disableWebPagePreview',
      label: '关闭链接预览',
      group: '通知配置',
      control: 'switch',
      required: false,
      secret: false,
      default: true,
    },
    {
      key: 'protectContent',
      label: '禁止转发与保存',
      group: '通知配置',
      control: 'switch',
      required: false,
      secret: false,
      default: false,
    },
  ];

  readonly configSchema = telegramConfigSchema;

  constructor(
    private readonly policy: PrivateNetworkPolicy,
    private readonly httpPost: HttpPostFn,
  ) {}

  mergeConfig(
    rawInput: unknown,
    existing: TelegramConfig | null,
    enabled: boolean,
    policy: PrivateNetworkPolicy,
  ): TelegramConfig | null {
    if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
      throw new ValidationError('Telegram 配置必须是 JSON 对象');
    }
    const body = rawInput as Record<string, unknown>;

    const rawBase =
      body.apiBaseUrl === undefined
        ? (existing?.apiBaseUrl ?? DEFAULT_API_BASE)
        : typeof body.apiBaseUrl === 'string'
          ? body.apiBaseUrl.trim() || DEFAULT_API_BASE
          : '';
    const apiBaseUrl = parsePublicHttpUrl(rawBase, 'Telegram Bot API 地址', policy).replace(/\/$/, '');

    const botToken =
      body.botToken === undefined
        ? (existing?.botToken ?? '')
        : typeof body.botToken === 'string'
          ? body.botToken.trim()
          : '';

    const chatId =
      body.chatId === undefined
        ? (existing?.chatId ?? '')
        : typeof body.chatId === 'string'
          ? body.chatId.trim()
          : '';

    const config: TelegramConfig = { botToken, chatId };
    if (apiBaseUrl !== DEFAULT_API_BASE) {
      config.apiBaseUrl = apiBaseUrl;
    }

    const threadId = body.messageThreadId === undefined ? existing?.messageThreadId : body.messageThreadId;
    if (threadId !== undefined && threadId !== null && threadId !== '') {
      if (typeof threadId !== 'number' || !Number.isInteger(threadId) || threadId < 1) {
        throw new ValidationError('Telegram 话题 ID 必须是大于 0 的整数');
      }
      config.messageThreadId = threadId;
    }

    const parseMode = body.parseMode === undefined ? existing?.parseMode : body.parseMode;
    if (parseMode !== undefined && parseMode !== null && parseMode !== '') {
      if (typeof parseMode !== 'string' || !(telegramParseModes as readonly string[]).includes(parseMode)) {
        throw new ValidationError('Telegram 消息格式无效');
      }
      config.parseMode = parseMode as TelegramParseMode;
    }

    const disableNotification =
      body.disableNotification === undefined ? existing?.disableNotification : body.disableNotification;
    if (disableNotification !== undefined && disableNotification !== null) {
      if (typeof disableNotification !== 'boolean') throw new ValidationError('Telegram 静默设置无效');
      config.disableNotification = disableNotification;
    }

    const disableWebPagePreview =
      body.disableWebPagePreview === undefined ? existing?.disableWebPagePreview : body.disableWebPagePreview;
    if (disableWebPagePreview !== undefined && disableWebPagePreview !== null) {
      if (typeof disableWebPagePreview !== 'boolean') throw new ValidationError('Telegram 链接预览设置无效');
      config.disableWebPagePreview = disableWebPagePreview;
    }

    const protectContent = body.protectContent === undefined ? existing?.protectContent : body.protectContent;
    if (protectContent !== undefined && protectContent !== null) {
      if (typeof protectContent !== 'boolean') throw new ValidationError('Telegram 内容保护设置无效');
      config.protectContent = protectContent;
    }

    if (botToken && !BOT_TOKEN_PATTERN.test(botToken)) {
      throw new ValidationError('Telegram Bot Token 格式无效（应类似 123456:ABC...）');
    }
    if (enabled && (!botToken || !chatId)) {
      throw new ValidationError('启用 Telegram 前请填写有效的 Bot Token 和 Chat ID');
    }

    return botToken || chatId ? config : null;
  }

  isConfigured(config: TelegramConfig | null): boolean {
    return Boolean(config?.botToken && BOT_TOKEN_PATTERN.test(config.botToken) && config?.chatId);
  }

  maskConfig(config: TelegramConfig | null): MaskedChannelConfig {
    if (!config) {
      return { config: null, secretsSet: [], configured: false, summary: [] };
    }
    const summary: ChannelSummaryItem[] = [];
    if (config.chatId) summary.push({ label: 'Chat ID', value: config.chatId });
    if (config.apiBaseUrl && config.apiBaseUrl !== DEFAULT_API_BASE) {
      summary.push({ label: 'API 反代', value: hostSummaryFromUrl(config.apiBaseUrl) });
    }
    const opts = [
      config.parseMode === 'HTML' ? 'HTML' : '纯文本',
      config.disableNotification ? '静默' : '',
      config.messageThreadId ? `Topic #${config.messageThreadId}` : '',
    ].filter(Boolean);
    if (opts.length) summary.push({ label: '配置', value: opts.join(' · ') });

    return {
      config: { apiBaseUrl: DEFAULT_API_BASE, ...config },
      secretsSet: [],
      configured: this.isConfigured(config),
      summary,
    };
  }

  private buildMessageText(message: NotificationMessage, parseMode: TelegramParseMode): {
    text: string;
    parseMode?: 'HTML';
  } {
    const footer = formatTimeLine(message, true);

    if (parseMode === 'HTML') {
      const footerHtml = `<i>${escapeHtml(footer)}</i>`;
      const maxTitleBudget = Math.max(0, TELEGRAM_TEXT_LIMIT - footerHtml.length - 16);
      const headerHtml = `<b>${escapeAndTruncateHtml(message.title, maxTitleBudget, '…')}</b>`;
      const bodyHtml = message.contentHtml
        ? contentHtmlToTelegramHtml(message.contentHtml)
        : escapeHtml(message.content);
      const assembled = [headerHtml, bodyHtml, footerHtml].filter(Boolean).join('\n\n');
      if (assembled.length <= TELEGRAM_TEXT_LIMIT) {
        return { text: assembled, parseMode: 'HTML' };
      }
      const budget = Math.max(0, TELEGRAM_TEXT_LIMIT - headerHtml.length - footerHtml.length - 4);
      const safeBody = escapeAndTruncateHtml(message.content, budget);
      return {
        text: [headerHtml, safeBody, footerHtml].filter(Boolean).join('\n\n'),
        parseMode: 'HTML',
      };
    }

    const budget = Math.max(0, TELEGRAM_TEXT_LIMIT - message.title.length - footer.length - 4);
    const body = truncateByChars(message.content, budget);
    return {
      text: [message.title, body, footer].filter(Boolean).join('\n\n'),
    };
  }

  async send(
    message: NotificationMessage,
    config: TelegramConfig,
    options?: NotificationSendOptions,
  ): Promise<NotificationResult> {
    try {
      const baseUrl = (config.apiBaseUrl || DEFAULT_API_BASE).replace(/\/$/, '');
      const { text, parseMode } = this.buildMessageText(message, config.parseMode ?? 'none');

      const payload: Record<string, unknown> = {
        chat_id: config.chatId,
        text,
        message_thread_id: config.messageThreadId,
        parse_mode: parseMode,
        disable_notification: config.disableNotification || undefined,
        link_preview_options: config.disableWebPagePreview !== false ? { is_disabled: true } : undefined,
        protect_content: config.protectContent || undefined,
      };

      const response = await this.httpPost({
        url: `${baseUrl}/bot${config.botToken}/sendMessage`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeoutMs: 15_000,
        policy: this.policy,
        proxy: options?.proxy,
      });

      return resultFromHttpResponse(response, (body) => {
        if (!body || typeof body !== 'object') {
          return { ok: false, error: 'Telegram 返回格式无效', errorClass: 'permanent' };
        }
        const parsed = body as { ok?: unknown; description?: unknown; error_code?: unknown };
        if (parsed.ok === true) return { ok: true, error: null };
        const errorCode = typeof parsed.error_code === 'number' ? parsed.error_code : response.status;
        return {
          ok: false,
          error: typeof parsed.description === 'string' && parsed.description ? parsed.description : 'Telegram 发送失败',
          errorClass: classifyHttpStatus(errorCode),
        };
      });
    } catch (error) {
      return resultFromError(error);
    }
  }
}
