import * as crypto from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { conflict, notFound, ValidationError } from '../../common/errors';
import { epochToIso } from '../../common/time';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import type {
  ChannelSummaryItem,
  ChannelTypeDescriptor,
  NotificationMessage,
  NotificationResult,
} from '../notifications/channel-provider.interface';
import { ChannelRegistry } from '../notifications/channel-registry.service';
import { PrivateNetworkPolicy } from '../notifications/http/url-policy';
import { SettingsService } from '../settings/settings.service';
import { type ChannelRow, ChannelsRepository } from './channels.repository';

export interface ChannelView {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  supported: boolean;
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
  config: Record<string, unknown> | null;
}

@Injectable()
export class ChannelsService {
  private readonly policy: PrivateNetworkPolicy;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly repo: ChannelsRepository,
    private readonly registry: ChannelRegistry,
    private readonly settings: SettingsService,
  ) {
    this.policy = new PrivateNetworkPolicy(config.allowedPrivateHosts, config.allowPrivateUrls);
  }

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

  toView(row: ChannelRow): ChannelView {
    const provider = this.registry.get(row.type);
    const rawConfig = this.parseRawConfig(row.config);
    if (!provider) {
      return {
        id: row.id,
        name: row.name,
        type: row.type,
        enabled: row.enabled === 1,
        supported: false,
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
      config: masked.config,
      secretsSet: masked.secretsSet,
      configured: masked.configured,
      summary: masked.summary,
      createdAt: epochToIso(row.created_at),
      updatedAt: epochToIso(row.updated_at),
    };
  }

  getInternal(id: string): StoredChannelInternal | null {
    const row = this.repo.findById(id);
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      enabled: row.enabled === 1,
      supported: this.registry.has(row.type),
      config: this.parseRawConfig(row.config),
    };
  }

  list(): ChannelView[] {
    return this.repo.findAll().map((row) => this.toView(row));
  }

  getById(id: string): ChannelView {
    const row = this.repo.findById(id);
    if (!row) throw notFound('通知渠道不存在');
    return this.toView(row);
  }

  create(raw: unknown): ChannelView {
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
      // Support both `{ config: {...} }` (API.md) and flat fields for robustness
      const rawConfig = body.config !== undefined ? body.config : body;
      merged = provider.mergeConfig(rawConfig, null, enabled, this.policy);
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    this.repo.insert({
      id,
      name,
      type,
      enabled: enabled ? 1 : 0,
      config: merged ? JSON.stringify(merged) : null,
      created_at: now,
      updated_at: now,
    });
    return this.getById(id);
  }

  update(id: string, raw: unknown): ChannelView {
    const existing = this.repo.findById(id);
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
      this.repo.update(id, {
        name,
        enabled: 0,
        config: existing.config,
        updated_at: Date.now(),
      });
      return this.getById(id);
    }

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

    this.repo.update(id, {
      name,
      enabled: enabled ? 1 : 0,
      config: nextConfig ? JSON.stringify(nextConfig) : null,
      updated_at: Date.now(),
    });
    return this.getById(id);
  }

  delete(id: string): void {
    const existing = this.repo.findById(id);
    if (!existing) throw notFound('通知渠道不存在');
    const { reminderCount, deliveryCount } = this.repo.usageCounts(id);
    if (reminderCount > 0 || deliveryCount > 0) {
      throw conflict('该渠道已被提醒或发送日志引用，不能删除；可以改为停用');
    }
    this.repo.delete(id);
  }

  async test(id: string): Promise<NotificationResult> {
    const existing = this.repo.findById(id);
    if (!existing) throw notFound('通知渠道不存在');

    const provider = this.registry.get(existing.type);
    if (!provider) {
      return {
        ok: false,
        httpStatus: null,
        responseSummary: '',
        error: '渠道类型暂不支持',
      };
    }

    const config = this.parseRawConfig(existing.config);
    if (!config || !provider.isConfigured(config)) {
      return {
        ok: false,
        httpStatus: null,
        responseSummary: '',
        error: '请先填写并保存完整渠道配置',
      };
    }

    const now = Date.now();
    const message: NotificationMessage = {
      eventId: crypto.randomUUID(),
      reminderId: 'test',
      title: 'TickBell 测试通知',
      content: `渠道“${existing.name}”配置正确。`,
      timezone: this.settings.getGlobalTimezone(),
      scheduledAt: now,
      triggeredAt: now,
      isTest: true,
    };
    const result = await provider.send(message, config);
    return {
      ok: result.ok,
      httpStatus: result.httpStatus,
      responseSummary: result.responseSummary,
      error: result.error,
    };
  }
}
