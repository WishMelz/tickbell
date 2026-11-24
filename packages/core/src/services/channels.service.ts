import { conflict, notFound, ValidationError } from '../common/errors';
import { epochToIso } from '../common/time';
import { randomUuid } from '../crypto/index';
import type {
  ChannelSummaryItem,
  ChannelTypeDescriptor,
  NotificationMessage,
  NotificationResult,
} from '../notifications/channel-provider.interface';
import type { ChannelRegistry } from '../notifications/channel-registry';
import type { PrivateNetworkPolicy } from '../notifications/http/url-policy';
import type { ProxyProtocol } from '../ports/index';
import type { ChannelRow, ChannelsRepository } from '../repositories/channels.repository';
import type { ProxyRow } from '../repositories/proxies.repository';
import type { ProxiesService } from './proxies.service';
import type { SettingsService } from './settings.service';

export interface ChannelView {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  supported: boolean;
  proxyId: string | null;
  proxyName: string | null;
  proxyProtocol: ProxyProtocol | null;
  proxyEnabled: boolean | null;
  config: Record<string, unknown> | null;
  secretsSet: string[];
  configured: boolean;
  summary: ChannelSummaryItem[];
  createdAt: string;
  updatedAt: string;
}

export interface StoredChannelInternal {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  supported: boolean;
  proxyId: string | null;
  config: Record<string, unknown> | null;
}

export class ChannelsService {
  constructor(
    private readonly policy: PrivateNetworkPolicy,
    private readonly repo: ChannelsRepository,
    private readonly registry: ChannelRegistry,
    private readonly proxies: ProxiesService,
    private readonly settings: SettingsService,
    private readonly proxiesSupported: boolean,
  ) {}

  listTypes(): ChannelTypeDescriptor[] {
    return this.registry.listTypes();
  }

  private parseRawConfig(raw: string | null): Record<string, unknown> | null {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  private async parseProxyId(raw: unknown, fallback: string | null): Promise<string | null> {
    if (!this.proxiesSupported) return null;
    if (raw === undefined) return fallback;
    if (raw === null) return null;
    if (typeof raw !== 'string') {
      throw new ValidationError('代理 ID 无效');
    }
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (!(await this.proxies.getRow(trimmed))) {
      throw new ValidationError('所选代理不存在，请刷新后重试');
    }
    return trimmed;
  }

  private buildView(row: ChannelRow, proxyRow: ProxyRow | null): ChannelView {
    const provider = this.registry.get(row.type);
    const rawConfig = this.parseRawConfig(row.config);
    const proxyFields = {
      proxyId: proxyRow ? proxyRow.id : null,
      proxyName: proxyRow ? proxyRow.name : null,
      proxyProtocol: proxyRow ? proxyRow.protocol : null,
      proxyEnabled: proxyRow ? proxyRow.enabled === 1 : null,
    };
    if (!provider) {
      return {
        id: row.id,
        name: row.name,
        type: row.type,
        enabled: row.enabled === 1,
        supported: false,
        ...proxyFields,
        config: null,
        secretsSet: [],
        configured: false,
        summary: [],
        createdAt: epochToIso(row.created_at),
        updatedAt: epochToIso(row.updated_at),
      };
    }
    const masked = provider.maskConfig(rawConfig);
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      enabled: row.enabled === 1,
      supported: true,
      ...proxyFields,
      config: masked.config,
      secretsSet: masked.secretsSet,
      configured: masked.configured,
      summary: masked.summary,
      createdAt: epochToIso(row.created_at),
      updatedAt: epochToIso(row.updated_at),
    };
  }

  async getInternal(id: string): Promise<StoredChannelInternal | null> {
    const row = await this.repo.findById(id);
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      enabled: row.enabled === 1,
      supported: this.registry.has(row.type),
      proxyId: row.proxy_id,
      config: this.parseRawConfig(row.config),
    };
  }

  async list(): Promise<ChannelView[]> {
    const rows = await this.repo.findAll();
    const proxyMap = new Map<string, ProxyRow>();
    if (this.proxiesSupported) {
      const uniqueProxyIds = [...new Set(rows.map((r) => r.proxy_id).filter((id): id is string => Boolean(id)))];
      for (const pid of uniqueProxyIds) {
        const p = await this.proxies.getRow(pid);
        if (p) proxyMap.set(pid, p);
      }
    }
    return rows.map((row) => this.buildView(row, row.proxy_id ? (proxyMap.get(row.proxy_id) ?? null) : null));
  }

  async getById(id: string): Promise<ChannelView> {
    const row = await this.repo.findById(id);
    if (!row) throw notFound('通知渠道不存在');
    const proxyRow = row.proxy_id ? await this.proxies.getRow(row.proxy_id) : null;
    return this.buildView(row, proxyRow);
  }

  async create(raw: unknown): Promise<ChannelView> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ValidationError('请求体必须是 JSON 对象');
    }
    const body = raw as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const type = typeof body.type === 'string' ? body.type.trim() : '';
    const enabled = body.enabled === true;

    if (!name || name.length > 80) {
      throw new ValidationError('渠道名称长度必须为 1 到 80 个字符');
    }
    const provider = this.registry.get(type);
    if (!provider) {
      throw new ValidationError('不支持的通知渠道类型');
    }

    let merged: Record<string, unknown> | null;
    if (body.config === null) {
      if (enabled) {
        throw new ValidationError('启用通知渠道前必须填写完整配置');
      }
      merged = null;
    } else {
      const rawConfig = body.config !== undefined ? body.config : body;
      merged = provider.mergeConfig(rawConfig, null, enabled, this.policy);
    }

    const proxyId = await this.parseProxyId(body.proxyId, null);

    const id = randomUuid();
    const now = Date.now();
    await this.repo.insert({
      id,
      name,
      type,
      enabled: enabled ? 1 : 0,
      config: merged ? JSON.stringify(merged) : null,
      proxy_id: proxyId,
      created_at: now,
      updated_at: now,
    });
    return this.getById(id);
  }

  async update(id: string, raw: unknown): Promise<ChannelView> {
    const existing = await this.repo.findById(id);
    if (!existing) throw notFound('通知渠道不存在');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ValidationError('请求体必须是 JSON 对象');
    }

    const body = raw as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const enabled = body.enabled === true;
    if (!name || name.length > 80) {
      throw new ValidationError('渠道名称长度必须为 1 到 80 个字符');
    }

    const provider = this.registry.get(existing.type);
    if (!provider) {
      if (enabled) {
        throw new ValidationError('暂不支持该渠道类型，不能启用');
      }
      if (body.config !== undefined) {
        throw new ValidationError('暂不支持该渠道类型，只能修改名称或保持停用');
      }
      await this.repo.update(id, {
        name,
        enabled: 0,
        config: existing.config,
        proxy_id: existing.proxy_id,
        updated_at: Date.now(),
      });
      return this.getById(id);
    }

    const proxyId = await this.parseProxyId(body.proxyId, existing.proxy_id);
    const existingConfig = this.parseRawConfig(existing.config);
    let nextConfig: Record<string, unknown> | null;
    if (body.config === undefined) {
      if (enabled && !provider.isConfigured(existingConfig)) {
        throw new ValidationError('启用通知渠道前必须填写完整配置');
      }
      nextConfig = existingConfig;
    } else if (body.config === null) {
      if (enabled) {
        throw new ValidationError('启用通知渠道前必须填写完整配置');
      }
      nextConfig = null;
    } else {
      nextConfig = provider.mergeConfig(body.config, existingConfig, enabled, this.policy);
    }

    await this.repo.update(id, {
      name,
      enabled: enabled ? 1 : 0,
      config: nextConfig ? JSON.stringify(nextConfig) : null,
      proxy_id: proxyId,
      updated_at: Date.now(),
    });
    return this.getById(id);
  }

  async delete(id: string): Promise<void> {
    const existing = await this.repo.findById(id);
    if (!existing) throw notFound('通知渠道不存在');
    const { reminderCount, deliveryCount } = await this.repo.usageCounts(id);
    if (reminderCount > 0 || deliveryCount > 0) {
      throw conflict('该渠道已被提醒或发送日志引用，不能删除；可以改为停用');
    }
    await this.repo.delete(id);
  }

  async test(id: string): Promise<NotificationResult> {
    const existing = await this.repo.findById(id);
    if (!existing) throw notFound('通知渠道不存在');

    const provider = this.registry.get(existing.type);
    if (!provider) {
      return { ok: false, httpStatus: null, responseSummary: '', error: '渠道类型暂不支持' };
    }

    const config = this.parseRawConfig(existing.config);
    if (!config || !provider.isConfigured(config)) {
      return { ok: false, httpStatus: null, responseSummary: '', error: '请先填写并保存完整渠道配置' };
    }

    const resolvedProxy = await this.proxies.resolveForChannel(existing.proxy_id);
    if (resolvedProxy.error) {
      return { ok: false, httpStatus: null, responseSummary: '', error: resolvedProxy.error };
    }

    const now = Date.now();
    const message: NotificationMessage = {
      eventId: randomUuid(),
      reminderId: 'test',
      title: 'TickBell 测试通知',
      content: `渠道“${existing.name}”配置正确。`,
      timezone: await this.settings.getGlobalTimezone(),
      scheduledAt: now,
      triggeredAt: now,
      isTest: true,
    };
    const result = await provider.send(message, config, { proxy: resolvedProxy.target });
    return {
      ok: result.ok,
      httpStatus: result.httpStatus,
      responseSummary: result.responseSummary,
      error: result.error,
    };
  }
}
