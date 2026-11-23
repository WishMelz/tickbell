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
  formatTimeLine,
  hostSummaryFromUrl,
  truncateByChars,
  truncateByUtf8Bytes,
} from '../http/message-format';
import {
  type HttpPostFn,
  pinnedHttpPost,
  resultFromError,
  resultFromHttpResponse,
} from '../http/pinned-fetch';
import { parsePublicHttpUrl, PrivateNetworkPolicy } from '../http/url-policy';

export const serverChanConfigSchema = z.strictObject({
  sendKey: z.string(),
  apiUrl: z.string().min(1).optional(),
  channel: z.string().max(80).optional(),
  tags: z.string().max(120).optional(),
  short: z.string().max(64).optional(),
  noip: z.boolean().optional(),
});

export type ServerChanConfig = z.infer<typeof serverChanConfigSchema>;

const SCTP_KEY_RE = /^sctp(\d+)t/i;
const SERVERCHAN_TITLE_LIMIT = 32;
const SERVERCHAN_DESP_MAX_BYTES = 32 * 1024;
const SERVERCHAN_RETRYABLE_CODES = new Set([40001]);

/**
 * Resolves the official ServerChan endpoint from SendKey:
 * - Custom `apiUrl` takes precedence (self-hosted / reverse proxy)
 * - `sctp{uid}t...` -> ServerChan³ (`https://{uid}.push.ft07.com/send/{sendKey}.send`)
 * - Otherwise -> ServerChan Turbo (`https://sctapi.ftqq.com/{sendKey}.send`)
 */
export function resolveServerChanUrl(sendKey: string, apiUrl?: string): { url: string; edition: string } {
  if (apiUrl?.trim()) {
    return { url: apiUrl.trim(), edition: `自定义网关 (${hostSummaryFromUrl(apiUrl.trim())})` };
  }
  const sctpMatch = SCTP_KEY_RE.exec(sendKey);
  if (sctpMatch?.[1]) {
    return {
      url: `https://${sctpMatch[1]}.push.ft07.com/send/${encodeURIComponent(sendKey)}.send`,
      edition: 'Server酱³',
    };
  }
  return {
    url: `https://sctapi.ftqq.com/${encodeURIComponent(sendKey)}.send`,
    edition: 'Server酱 Turbo',
  };
}

@Injectable()
export class ServerChanProvider implements ChannelProvider<ServerChanConfig> {
  readonly type = 'serverchan';

  readonly meta: ChannelMeta = {
    type: 'serverchan',
    name: 'Server酱',
    description: '支持 Server酱 Turbo（SCT...）与 Server酱³（sctp...）自动识别路由',
    icon: 'key',
    order: 6,
  };

  readonly fields: readonly ChannelField[] = [
    {
      key: 'sendKey',
      label: 'SendKey',
      group: '连接与鉴权',
      control: 'text',
      required: true,
      secret: false,
      placeholder: 'SCT... 或 sctp1234t...',
      help: '支持自动识别 Server酱 Turbo（SCT 开头）与 Server酱³（sctp 开头）',
    },
    {
      key: 'apiUrl',
      label: '自定义接口地址（可选）',
      group: '连接与鉴权',
      control: 'url',
      required: false,
      secret: false,
      placeholder: '留空按 SendKey 自动选择官方接口',
      help: '如需走自建反代或兼容接口，可填写完整推送 URL',
    },
    {
      key: 'channel',
      label: '推送通道编号（Turbo 可选）',
      group: '通知配置',
      control: 'text',
      required: false,
      secret: false,
      placeholder: '例如：9（方糖服务号）或 9|98',
      help: '留空使用 Server酱官网默认通道，多通道用 | 分隔',
    },
    {
      key: 'tags',
      label: '消息标签（Server酱³ 可选）',
      group: '通知配置',
      control: 'text',
      required: false,
      secret: false,
      placeholder: '例如：提醒|重要',
      help: 'Server酱³ 消息标签，多个用 | 分隔',
    },
    {
      key: 'short',
      label: '卡片简短描述（可选）',
      group: '通知配置',
      control: 'text',
      required: false,
      secret: false,
      placeholder: '最多 64 字，留空自动截取正文',
    },
    {
      key: 'noip',
      label: '隐藏调用 IP',
      group: '通知配置',
      control: 'switch',
      required: false,
      secret: false,
      default: false,
    },
  ];

  readonly configSchema = serverChanConfigSchema;

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
    existing: ServerChanConfig | null,
    enabled: boolean,
    policy: PrivateNetworkPolicy,
  ): ServerChanConfig | null {
    if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
      throw new ValidationError('Server酱配置必须是 JSON 对象');
    }
    const body = rawInput as Record<string, unknown>;

    const sendKey =
      body.sendKey === undefined
        ? (existing?.sendKey ?? '')
        : typeof body.sendKey === 'string'
          ? body.sendKey.trim()
          : '';
    if (sendKey && (sendKey.length > 200 || /\s/.test(sendKey))) {
      throw new ValidationError('Server酱 SendKey 格式无效');
    }

    const rawApiUrl =
      body.apiUrl === undefined
        ? (existing?.apiUrl ?? '')
        : typeof body.apiUrl === 'string'
          ? body.apiUrl.trim()
          : '';

    if (enabled && !sendKey && !rawApiUrl) {
      throw new ValidationError('启用 Server酱前请填写 SendKey');
    }
    if (!sendKey && !rawApiUrl) return null;

    const config: ServerChanConfig = { sendKey };
    if (rawApiUrl) {
      config.apiUrl = parsePublicHttpUrl(rawApiUrl, 'Server酱自定义接口地址', policy);
    }

    const channel = body.channel === undefined ? existing?.channel : body.channel;
    if (channel !== undefined && channel !== null) {
      if (typeof channel !== 'string' || channel.trim().length > 80) {
        throw new ValidationError('Server酱推送通道编号不能超过 80 个字符');
      }
      if (channel.trim()) config.channel = channel.trim();
    }

    const tags = body.tags === undefined ? existing?.tags : body.tags;
    if (tags !== undefined && tags !== null) {
      if (typeof tags !== 'string' || tags.trim().length > 120) {
        throw new ValidationError('Server酱标签不能超过 120 个字符');
      }
      if (tags.trim()) config.tags = tags.trim();
    }

    const short = body.short === undefined ? existing?.short : body.short;
    if (short !== undefined && short !== null) {
      if (typeof short !== 'string' || short.trim().length > 64) {
        throw new ValidationError('Server酱简短描述不能超过 64 个字符');
      }
      if (short.trim()) config.short = short.trim();
    }

    const noip = body.noip === undefined ? existing?.noip : body.noip;
    if (noip !== undefined && noip !== null) {
      if (typeof noip !== 'boolean') throw new ValidationError('Server酱隐藏 IP 设置无效');
      config.noip = noip;
    }

    return config;
  }

  isConfigured(config: ServerChanConfig | null): boolean {
    return Boolean(config && (config.sendKey || config.apiUrl));
  }

  maskConfig(config: ServerChanConfig | null): MaskedChannelConfig {
    if (!config) {
      return { config: null, secretsSet: [], configured: false, summary: [] };
    }
    const { edition } = resolveServerChanUrl(config.sendKey, config.apiUrl);
    const summary: ChannelSummaryItem[] = [{ label: '路由', value: edition }];
    if (config.sendKey) summary.push({ label: 'SendKey', value: config.sendKey });
    const opts = [config.channel ? `通道：${config.channel}` : '', config.tags ? `标签：${config.tags}` : ''].filter(
      Boolean,
    );
    if (opts.length) summary.push({ label: '配置', value: opts.join(' · ') });

    return {
      config: { ...config },
      secretsSet: [],
      configured: this.isConfigured(config),
      summary,
    };
  }

  async send(message: NotificationMessage, config: ServerChanConfig): Promise<NotificationResult> {
    try {
      const { url } = resolveServerChanUrl(config.sendKey, config.apiUrl);
      const timeLine = formatTimeLine(message);

      // ServerChan Turbo caps `title` at 32 chars; preserve the full title inside `desp` if truncated
      const titleTruncated = message.title.length > SERVERCHAN_TITLE_LIMIT;
      const title = titleTruncated
        ? truncateByChars(message.title, SERVERCHAN_TITLE_LIMIT, '…')
        : message.title;
      const rawDesp = [
        titleTruncated ? `**${message.title}**` : '',
        message.content,
        `> ${timeLine}`,
      ]
        .filter(Boolean)
        .join('\n\n');
      const desp = truncateByUtf8Bytes(rawDesp, SERVERCHAN_DESP_MAX_BYTES);

      const payload: Record<string, unknown> = {
        title,
        desp,
        short: config.short || undefined,
        channel: config.channel || undefined,
        tags: config.tags || undefined,
        noip: config.noip ? 1 : undefined,
      };

      const response = await this.httpPost({
        url,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeoutMs: 15_000,
        policy: this.policy,
      });

      return resultFromHttpResponse(response, (body) => {
        if (!body || typeof body !== 'object') {
          return { ok: false, error: 'Server酱返回格式无效', errorClass: 'permanent' };
        }
        const parsed = body as { code?: unknown; errno?: unknown; message?: unknown; errmsg?: unknown };
        if (parsed.code === 0 || parsed.errno === 0) {
          return { ok: true, error: null };
        }
        const code =
          typeof parsed.code === 'number'
            ? parsed.code
            : typeof parsed.errno === 'number'
              ? parsed.errno
              : -999;
        const msg =
          (typeof parsed.message === 'string' && parsed.message)
          || (typeof parsed.errmsg === 'string' && parsed.errmsg)
          || `Server酱发送失败(${code})`;
        return {
          ok: false,
          error: `Server酱错误(${code})：${msg}`,
          errorClass: SERVERCHAN_RETRYABLE_CODES.has(code) ? 'retryable' : 'permanent',
        };
      });
    } catch (error) {
      return resultFromError(error);
    }
  }
}
