import * as crypto from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { notFound, ValidationError } from '../../common/errors';
import { calculateNextFutureRun, type RepeatUnit } from '../../common/repeat';
import { epochToIso, epochToLocalInput } from '../../common/time';
import { ChannelsRepository } from '../channels/channels.repository';
import { ChannelsService } from '../channels/channels.service';
import { DatabaseService } from '../database/database.service';
import type { NotificationMessage } from '../notifications/channel-provider.interface';
import { ChannelRegistry } from '../notifications/channel-registry.service';
import { runWithProxyContext } from '../notifications/http/proxy-dispatcher';
import { ProxiesService } from '../proxies/proxies.service';
import { SettingsService } from '../settings/settings.service';
import {
  type ReminderListFilters,
  type ReminderRow,
  RemindersRepository,
  type ReminderStatusFilter,
} from './reminders.repository';
import { validateReminderBatchInput, validateReminderInput } from './reminders.validation';

export interface ReminderView {
  id: string;
  title: string;
  content: string;
  contentHtml: string | null;
  category: string;
  tags: string[];
  timezone: string;
  usesGlobalTimezone: boolean;
  scheduledLocal: string;
  startsAt: string;
  isRepeating: boolean;
  repeatEvery: number | null;
  repeatUnit: RepeatUnit | null;
  channelIds: string[];
  enabled: boolean;
  completed: boolean;
  nextRunAt: string;
  nextRunLocal: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReminderBatchResult {
  updated: number;
  skipped: number;
}

export interface ReminderTestResult {
  channelId: string;
  channelName: string;
  ok: boolean;
  error: string | null;
}

@Injectable()
export class RemindersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repo: RemindersRepository,
    private readonly channelsRepo: ChannelsRepository,
    private readonly channelsService: ChannelsService,
    private readonly registry: ChannelRegistry,
    private readonly proxies: ProxiesService,
    private readonly settings: SettingsService,
  ) {}

  private toView(row: ReminderRow, channelIds: string[], globalTimezone: string): ReminderView {
    const timezone = row.timezone ?? globalTimezone;
    let tags: string[] = [];
    try {
      const parsed = JSON.parse(row.tags || '[]') as unknown;
      if (Array.isArray(parsed)) {
        tags = parsed.filter((item): item is string => typeof item === 'string');
      }
    } catch {
      tags = [];
    }
    return {
      id: row.id,
      title: row.title,
      content: row.content,
      contentHtml: row.content_html ?? null,
      category: row.category ?? '',
      tags,
      timezone,
      usesGlobalTimezone: row.timezone === null,
      scheduledLocal: epochToLocalInput(row.starts_at, timezone),
      startsAt: epochToIso(row.starts_at),
      isRepeating: row.is_repeating === 1,
      repeatEvery: row.repeat_every,
      repeatUnit: row.repeat_unit,
      channelIds,
      enabled: row.enabled === 1,
      completed: row.completed === 1,
      nextRunAt: epochToIso(row.next_run_at),
      nextRunLocal: epochToLocalInput(row.next_run_at, timezone),
      createdAt: epochToIso(row.created_at),
      updatedAt: epochToIso(row.updated_at),
    };
  }

  private ensureChannelsExist(channelIds: string[]): void {
    const existing = this.channelsRepo.findByIds(channelIds);
    if (existing.length !== channelIds.length) {
      throw new ValidationError('所选通知渠道不存在，请刷新后重试');
    }
  }

  list(query: { search?: string; category?: string; tag?: string; status?: string }): ReminderView[] {
    const status =
      query.status === 'active' || query.status === 'paused' || query.status === 'completed'
        ? (query.status as ReminderStatusFilter)
        : undefined;
    const filters: ReminderListFilters = {
      search: query.search?.trim() || undefined,
      category: query.category?.trim() || undefined,
      tag: query.tag?.trim() || undefined,
      status,
    };
    const rows = this.repo.findAll(filters);
    const globalTimezone = this.settings.getGlobalTimezone();
    const channelMap = this.repo.getChannelIdsMap(rows.map((r) => r.id));
    return rows.map((row) => this.toView(row, channelMap.get(row.id) ?? [], globalTimezone));
  }

  getById(id: string): ReminderView {
    const row = this.repo.findById(id);
    if (!row) throw notFound('提醒不存在');
    const globalTimezone = this.settings.getGlobalTimezone();
    const channelIds = this.repo.getChannelIds(id);
    return this.toView(row, channelIds, globalTimezone);
  }

  create(raw: unknown): ReminderView {
    const globalTimezone = this.settings.getGlobalTimezone();
    const { input, startsAt } = validateReminderInput(raw, globalTimezone);

    const id = crypto.randomUUID();
    const now = Date.now();

    this.database.transaction(() => {
      this.ensureChannelsExist(input.channelIds);
      this.repo.insert(
        {
          id,
          title: input.title,
          content: input.content,
          content_html: input.contentHtml,
          category: input.category,
          tags: JSON.stringify(input.tags),
          timezone: input.timezone,
          starts_at: startsAt,
          is_repeating: input.isRepeating ? 1 : 0,
          repeat_every: input.repeatEvery,
          repeat_unit: input.repeatUnit,
          enabled: input.enabled ? 1 : 0,
          completed: 0,
          next_run_at: startsAt,
          created_at: now,
          updated_at: now,
        },
        input.channelIds,
      );
    });

    return this.getById(id);
  }

  update(id: string, raw: unknown): ReminderView {
    const globalTimezone = this.settings.getGlobalTimezone();
    const { input, startsAt } = validateReminderInput(raw, globalTimezone);

    this.database.transaction(() => {
      const existing = this.repo.findById(id);
      if (!existing) throw notFound('提醒不存在');
      this.ensureChannelsExist(input.channelIds);

      const scheduleChanged =
        existing.starts_at !== startsAt
        || existing.timezone !== input.timezone
        || existing.is_repeating !== (input.isRepeating ? 1 : 0)
        || existing.repeat_every !== input.repeatEvery
        || existing.repeat_unit !== input.repeatUnit;

      const nextEnabled = scheduleChanged && existing.completed === 1 ? 1 : existing.enabled;
      const nextCompleted = scheduleChanged ? 0 : existing.completed;
      const nextRunAt = scheduleChanged ? startsAt : existing.next_run_at;

      this.repo.update(
        id,
        {
          title: input.title,
          content: input.content,
          content_html: input.contentHtml,
          category: input.category,
          tags: JSON.stringify(input.tags),
          timezone: input.timezone,
          starts_at: startsAt,
          is_repeating: input.isRepeating ? 1 : 0,
          repeat_every: input.repeatEvery,
          repeat_unit: input.repeatUnit,
          enabled: nextEnabled,
          completed: nextCompleted,
          next_run_at: nextRunAt,
          updated_at: Date.now(),
        },
        input.channelIds,
      );
    });

    return this.getById(id);
  }

  softDelete(id: string): void {
    const deleted = this.database.transaction(() => this.repo.softDelete(id, Date.now()));
    if (!deleted) throw notFound('提醒不存在');
  }

  enable(id: string, now = Date.now()): ReminderView {
    this.database.transaction(() => {
      const row = this.repo.findById(id);
      if (!row) throw notFound('提醒不存在');
      if (row.completed === 1) {
        throw new ValidationError('已完成的提醒需要编辑时间后重新安排');
      }
      let nextRunAt = row.next_run_at;
      if (nextRunAt <= now) {
        if (row.is_repeating === 1 && row.repeat_every && row.repeat_unit) {
          const timezone = row.timezone ?? this.settings.getGlobalTimezone();
          nextRunAt = calculateNextFutureRun(row.next_run_at, now, {
            every: row.repeat_every,
            unit: row.repeat_unit,
            timezone,
            startsAt: row.starts_at,
          });
        } else {
          throw new ValidationError('提醒时间已过，请先修改时间');
        }
      }
      this.repo.setEnabledAndNextRun(id, 1, nextRunAt, now);
    });
    return this.getById(id);
  }

  disable(id: string, now = Date.now()): ReminderView {
    this.database.transaction(() => {
      const row = this.repo.findById(id);
      if (!row) throw notFound('提醒不存在');
      this.repo.setEnabledAndNextRun(id, 0, row.next_run_at, now);
    });
    return this.getById(id);
  }

  batch(raw: unknown, now = Date.now()): ReminderBatchResult {
    const input = validateReminderBatchInput(raw);

    return this.database.transaction(() => {
      if (input.action === 'channels') {
        this.ensureChannelsExist(input.channelIds);
        let updated = 0;
        for (const id of input.ids) {
          if (this.repo.replaceChannels(id, input.channelIds, now)) updated += 1;
        }
        return { updated, skipped: input.ids.length - updated };
      }

      if (input.action === 'delete') {
        let updated = 0;
        for (const id of input.ids) {
          if (this.repo.softDelete(id, now)) updated += 1;
        }
        return { updated, skipped: input.ids.length - updated };
      }

      const rows = this.repo.findByIds(input.ids);
      const rowMap = new Map(rows.map((r) => [r.id, r]));
      const globalTimezone = this.settings.getGlobalTimezone();
      let updated = 0;

      for (const id of input.ids) {
        const row = rowMap.get(id);
        if (!row) continue;

        if (input.action === 'disable') {
          if (row.enabled === 0) continue;
          if (this.repo.setEnabledAndNextRun(id, 0, row.next_run_at, now)) updated += 1;
          continue;
        }

        // action === 'enable'
        if (row.completed === 1 || row.enabled === 1) continue;
        let nextRunAt = row.next_run_at;
        if (nextRunAt <= now) {
          if (row.is_repeating === 1 && row.repeat_every && row.repeat_unit) {
            const timezone = row.timezone ?? globalTimezone;
            nextRunAt = calculateNextFutureRun(row.next_run_at, now, {
              every: row.repeat_every,
              unit: row.repeat_unit,
              timezone,
              startsAt: row.starts_at,
            });
          } else {
            // Single reminder in the past cannot be enabled directly
            continue;
          }
        }
        if (this.repo.setEnabledAndNextRun(id, 1, nextRunAt, now)) updated += 1;
      }

      return { updated, skipped: input.ids.length - updated };
    });
  }

  async test(raw: unknown): Promise<ReminderTestResult[]> {
    const globalTimezone = this.settings.getGlobalTimezone();
    const { input, startsAt, effectiveTimezone } = validateReminderInput(raw, globalTimezone);
    if (input.channelIds.length > 100) {
      throw new ValidationError('一次最多测试 100 个通知渠道');
    }

    const channels = input.channelIds.map((id) => this.channelsService.getInternal(id));
    if (channels.some((c) => !c)) {
      throw new ValidationError('通知渠道不存在，请刷新后重试');
    }

    const message: NotificationMessage = {
      eventId: crypto.randomUUID(),
      reminderId: 'test',
      title: input.title,
      content: input.content,
      contentHtml: input.contentHtml,
      timezone: effectiveTimezone,
      scheduledAt: startsAt,
      triggeredAt: Date.now(),
      isTest: true,
    };

    const results: ReminderTestResult[] = [];
    for (const channel of channels) {
      if (!channel) continue;
      const provider = this.registry.get(channel.type);
      if (!provider) {
        results.push({ channelId: channel.id, channelName: channel.name, ok: false, error: '渠道类型暂不支持' });
        continue;
      }
      if (!channel.enabled) {
        results.push({ channelId: channel.id, channelName: channel.name, ok: false, error: '通知渠道已关闭' });
        continue;
      }
      if (!channel.config || !provider.isConfigured(channel.config)) {
        results.push({ channelId: channel.id, channelName: channel.name, ok: false, error: '请先填写并保存完整渠道配置' });
        continue;
      }
      const resolvedProxy = this.proxies.resolveForChannel(channel.proxyId);
      if (resolvedProxy.error) {
        results.push({ channelId: channel.id, channelName: channel.name, ok: false, error: resolvedProxy.error });
        continue;
      }
      const res = await runWithProxyContext(resolvedProxy.target, () => provider.send(message, channel.config!));
      results.push({
        channelId: channel.id,
        channelName: channel.name,
        ok: res.ok,
        error: res.error,
      });
    }
    return results;
  }
}
