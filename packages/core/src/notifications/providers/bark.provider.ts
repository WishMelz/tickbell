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
import { formatTimeLine } from '../http/message-format';
import { parsePublicHttpUrl, type PrivateNetworkPolicy } from '../http/url-policy';

export const barkLevels = ['active', 'passive', 'timeSensitive', 'critical'] as const;
export type BarkLevel = (typeof barkLevels)[number];

export const barkConfigSchema = z.strictObject({
  serverUrl: z.string().min(1),
  deviceKey: z.string(),
  group: z.string().max(80).optional(),
  level: z.enum(barkLevels).optional(),
  sound: z.string().max(100).optional(),
  call: z.boolean().optional(),
  volume: z.number().int().min(0).max(10).optional(),
  icon: z.string().max(500).optional(),
  isArchive: z.boolean().optional(),
});

export type BarkConfig = z.infer<typeof barkConfigSchema>;

const DEFAULT_SERVER_URL = 'https://api.day.app';
const DEFAULT_GROUP = 'TickBell';

export class BarkProvider implements ChannelProvider<BarkConfig> {
  readonly type = 'bark';

  readonly meta: ChannelMeta = {
    type: 'bark',
    name: 'Bark',
    description: 'iOS 推送（支持自建 Bark 服务或官方服务）',
    icon: 'notifications',
    order: 1,
  };

  readonly fields: readonly ChannelField[] = [
    {
      key: 'serverUrl',
      label: 'Bark 服务器地址',
      group: '连接与鉴权',
      control: 'url',
      required: true,
      secret: false,
      default: DEFAULT_SERVER_URL,
      placeholder: 'https://api.day.app 或 https://bark.example.com',
      help: '默认使用官方 api.day.app；自部署模式也支持填写内网 / Docker 地址',
    },
    {
      key: 'deviceKey',
      label: '设备密钥（Device Key）',
      group: '连接与鉴权',
      control: 'text',
      required: true,
      secret: false,
      help: '从手机 Bark App 首页复制设备 Key（明文保存与回填，便于编辑）',
    },
    {
      key: 'group',
      label: '通知分组',
      group: '通知配置',
      control: 'text',
      required: false,
      secret: false,
      default: DEFAULT_GROUP,
      placeholder: 'TickBell',
      help: 'iOS 通知中心按此名称折叠分组',
    },
    {
      key: 'level',
      label: '通知级别',
      group: '通知配置',
      control: 'select',
      required: false,
      secret: false,
      default: 'active',
      options: [
        { label: '普通（active）', value: 'active' },
        { label: '静默（passive，不亮屏不响铃）', value: 'passive' },
        { label: '时效性（timeSensitive，穿透专注模式）', value: 'timeSensitive' },
        { label: '重要警告（critical，静音也响铃）', value: 'critical' },
      ],
    },
    {
      key: 'sound',
      label: '铃声名称',
      group: '通知配置',
      control: 'text',
      required: false,
      secret: false,
      placeholder: '留空使用默认铃声，如 alarm、bell、minuet',
      showWhen: { field: 'level', notIn: ['passive'] },
    },
    {
      key: 'call',
      label: '重复响铃 30 秒',
      group: '通知配置',
      control: 'switch',
      required: false,
      secret: false,
      default: false,
      showWhen: { field: 'level', notIn: ['passive'] },
    },
    {
      key: 'volume',
      label: '重要警告音量（0–10）',
      group: '通知配置',
      control: 'number',
      required: false,
      secret: false,
      default: 5,
      min: 0,
      max: 10,
      showWhen: { field: 'level', in: ['critical'] },
    },
    {
      key: 'icon',
      label: '自定义图标 URL（可选）',
      group: '通知配置',
      control: 'url',
      required: false,
      secret: false,
      placeholder: 'https://example.com/icon.png',
    },
    {
      key: 'isArchive',
      label: '保存到 Bark 历史记录',
      group: '通知配置',
      control: 'switch',
      required: false,
      secret: false,
      default: true,
    },
  ];

  readonly configSchema = barkConfigSchema;

  constructor(
    private readonly policy: PrivateNetworkPolicy,
    private readonly httpPost: HttpPostFn,
  ) {}

  mergeConfig(
    rawInput: unknown,
    existing: BarkConfig | null,
    enabled: boolean,
    policy: PrivateNetworkPolicy,
  ): BarkConfig | null {
    if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
      throw new ValidationError('Bark 配置必须是 JSON 对象');
    }
    const body = rawInput as Record<string, unknown>;

    const rawServerUrl = typeof body.serverUrl === 'string' ? body.serverUrl.trim() : '';
    const serverUrlInput = rawServerUrl || existing?.serverUrl || DEFAULT_SERVER_URL;
    const serverUrl = parsePublicHttpUrl(serverUrlInput, 'Bark Server URL', policy).replace(/\/$/, '');

    const deviceKey =
      body.deviceKey === undefined
        ? (existing?.deviceKey ?? '')
        : typeof body.deviceKey === 'string'
          ? body.deviceKey.trim()
          : '';
    const config: BarkConfig = { serverUrl, deviceKey };

    const group = body.group === undefined ? existing?.group : body.group;
    if (group !== undefined && group !== null) {
      if (typeof group !== 'string' || group.trim().length > 80) {
        throw new ValidationError('Bark 通知分组名称不能超过 80 个字符');
      }
      if (group.trim()) config.group = group.trim();
    }

    const level = body.level === undefined ? existing?.level : body.level;
    if (level !== undefined && level !== null && level !== '') {
      if (typeof level !== 'string' || !(barkLevels as readonly string[]).includes(level)) {
        throw new ValidationError('Bark 通知级别无效');
      }
      config.level = level as BarkLevel;
    }

    const sound = body.sound === undefined ? existing?.sound : body.sound;
    if (sound !== undefined && sound !== null) {
      if (typeof sound !== 'string' || sound.trim().length > 100 || /[\u0000-\u001f\u007f/\\]/.test(sound)) {
        throw new ValidationError('Bark 铃声名称无效，长度不能超过 100 个字符');
      }
      if (sound.trim()) config.sound = sound.trim();
    }

    const call = body.call === undefined ? existing?.call : body.call;
    if (call !== undefined && call !== null) {
      if (typeof call !== 'boolean') {
        throw new ValidationError('Bark 重复响铃设置无效');
      }
      config.call = call;
    }

    const volume = body.volume === undefined ? existing?.volume : body.volume;
    if (volume !== undefined && volume !== null) {
      if (typeof volume !== 'number' || !Number.isInteger(volume) || volume < 0 || volume > 10) {
        throw new ValidationError('Bark 重要警告音量必须为 0 到 10 的整数');
      }
      config.volume = volume;
    }

    const icon = body.icon === undefined ? existing?.icon : body.icon;
    if (icon !== undefined && icon !== null) {
      if (typeof icon !== 'string' || icon.trim().length > 500) {
        throw new ValidationError('Bark 图标 URL 长度不能超过 500 个字符');
      }
      if (icon.trim()) {
        config.icon = parsePublicHttpUrl(icon.trim(), 'Bark 图标 URL', policy);
      }
    }

    const isArchive = body.isArchive === undefined ? existing?.isArchive : body.isArchive;
    if (isArchive !== undefined && isArchive !== null) {
      if (typeof isArchive !== 'boolean') {
        throw new ValidationError('Bark 保存历史设置无效');
      }
      config.isArchive = isArchive;
    }

    if (enabled && !config.deviceKey) {
      throw new ValidationError('启用 Bark 前请填写 Device Key');
    }

    return config.deviceKey ? config : null;
  }

  isConfigured(config: BarkConfig | null): boolean {
    return Boolean(config?.serverUrl && config?.deviceKey);
  }

  maskConfig(config: BarkConfig | null): MaskedChannelConfig {
    if (!config) {
      return { config: null, secretsSet: [], configured: false, summary: [] };
    }
    const summary: ChannelSummaryItem[] = [];
    if (config.serverUrl) summary.push({ label: '地址', value: config.serverUrl });
    if (config.deviceKey) summary.push({ label: '密钥', value: config.deviceKey });
    const metaParts = [config.group ? `分组：${config.group}` : '', config.level ? `级别：${config.level}` : ''].filter(
      Boolean,
    );
    if (metaParts.length) summary.push({ label: '配置', value: metaParts.join(' · ') });

    return {
      config: { ...config },
      secretsSet: [],
      configured: this.isConfigured(config),
      summary,
    };
  }

  async send(
    message: NotificationMessage,
    config: BarkConfig,
    options?: NotificationSendOptions,
  ): Promise<NotificationResult> {
    try {
      const timeLine = formatTimeLine(message);

      const payload: Record<string, unknown> = {
        device_key: config.deviceKey,
        title: message.title,
        body: [message.content, timeLine].filter(Boolean).join('\n\n'),
        group: config.group || DEFAULT_GROUP,
        level: config.level,
        sound: config.level === 'passive' ? undefined : config.sound || undefined,
        call: config.level !== 'passive' && config.call ? '1' : undefined,
        volume: config.level === 'critical' && config.volume !== undefined ? String(config.volume) : undefined,
        icon: config.icon || undefined,
        isArchive: config.isArchive === false ? '0' : '1',
      };

      const response = await this.httpPost({
        url: `${config.serverUrl.replace(/\/$/, '')}/push`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeoutMs: 15_000,
        policy: this.policy,
        proxy: options?.proxy,
      });

      return resultFromHttpResponse(response, (body) => {
        if (!body || typeof body !== 'object') {
          return { ok: false, error: 'Bark 返回格式无效' };
        }
        const parsed = body as { code?: unknown; message?: unknown };
        return {
          ok: parsed.code === 200,
          error:
            parsed.code === 200
              ? null
              : typeof parsed.message === 'string' && parsed.message
                ? parsed.message
                : 'Bark 发送失败',
        };
      });
    } catch (error) {
      return resultFromError(error);
    }
  }
}
