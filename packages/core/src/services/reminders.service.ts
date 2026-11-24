import { notFound, ValidationError } from '../common/errors';
import { calculateNextFutureRun, type RepeatUnit } from '../common/repeat';
import { epochToIso, epochToLocalInput } from '../common/time';
import { randomUuid } from '../crypto/index';
import type { NotificationMessage } from '../notifications/channel-provider.interface';
import type { ChannelRegistry } from '../notifications/channel-registry';
import type { DbAdapter, SqlStatement } from '../ports/index';
import type { ChannelsRepository } from '../repositories/channels.repository';
import type {
  ReminderListFilters,
  ReminderRow,
  RemindersRepository,
  ReminderStatusFilter,
} from '../repositories/reminders.repository';
import type { ChannelsService } from './channels.service';
import type { ProxiesService } from './proxies.service';
import { validateReminderBatchInput, validateReminderInput } from './reminders.validation';
import type { SettingsService } from './settings.service';

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

export interface ReminderPage {
  items: ReminderView[];
  total: number;
  page: number;
  pageSize: number;
  categories: string[];
  tags: string[];
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

export class RemindersService {
  constructor(
    private readonly db: DbAdapter,
    private readonly repo: RemindersRepository,
    private readonly channelsRepo: ChannelsRepository,
    private readonly channelsService: ChannelsService,
    private readonly registry: ChannelRegistry,
    private readonly proxies: ProxiesService,
    private readonly settings: SettingsService,
    private readonly maxReminders?: number,
    private readonly maxTestChannels?: number,
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

  private async ensureChannelsExist(channelIds: readonly string[]): Promise<void> {
    const existing = await this.channelsRepo.findByIds(channelIds);
    if (existing.length !== channelIds.length) {
      throw new ValidationError('所选通知渠道不存在，请刷新后重试');
    }
  }

  private parseFilters(query: {
    search?: string;
    category?: string;
    tag?: string;
    status?: string;
    sort?: string;
  }): ReminderListFilters {
    const status =
      query.status === 'active' || query.status === 'paused' || query.status === 'completed'
        ? (query.status as ReminderStatusFilter)
        : undefined;
    return {
      search: query.search?.trim() || undefined,
      category: query.category?.trim() || undefined,
      tag: query.tag?.trim() || undefined,
      status,
      sort: query.sort === 'desc' ? 'desc' : 'asc',
    };
  }

  /** Legacy full-list mode (used when `page` is not specified). */
  async list(query: { search?: string; category?: string; tag?: string; status?: string; sort?: string }): Promise<ReminderView[]> {
    const filters = this.parseFilters(query);
    const [rows, globalTimezone, channelMap] = await Promise.all([
      this.repo.findAll(filters),
      this.settings.getGlobalTimezone(),
      this.repo.getAllActiveChannelIdsMap(),
    ]);
    return rows.map((row) => this.toView(row, channelMap.get(row.id) ?? [], globalTimezone));
  }

  /** Server-side paginated mode (`GET /api/reminders?page=1&pageSize=20`) — optimal for unlimited reminders on D1. */
  async listPage(query: {
    search?: string;
    category?: string;
    tag?: string;
    status?: string;
    sort?: string;
    page?: string;
    pageSize?: string;
  }): Promise<ReminderPage> {
    const filters = this.parseFilters(query);
    const pageNum = Number.parseInt(query.page ?? '1', 10);
    const sizeNum = Number.parseInt(query.pageSize ?? '20', 10);
    const page = Number.isFinite(pageNum) && pageNum >= 1 ? pageNum : 1;
    const pageSize = Number.isFinite(sizeNum) ? Math.min(100, Math.max(1, sizeNum)) : 20;

    const [{ items, total }, facets, globalTimezone] = await Promise.all([
      this.repo.findPage(filters, page, pageSize),
      this.repo.listFacets(),
      this.settings.getGlobalTimezone(),
    ]);
    const channelMap = await this.repo.getChannelIdsMap(items.map((r) => r.id));

    return {
      items: items.map((row) => this.toView(row, channelMap.get(row.id) ?? [], globalTimezone)),
      total,
      page,
      pageSize,
      categories: facets.categories,
      tags: facets.tags,
    };
  }

  async getById(id: string): Promise<ReminderView> {
    const row = await this.repo.findById(id);
    if (!row) throw notFound('提醒不存在');
    const [globalTimezone, channelIds] = await Promise.all([
      this.settings.getGlobalTimezone(),
      this.repo.getChannelIds(id),
    ]);
    return this.toView(row, channelIds, globalTimezone);
  }

  async create(raw: unknown): Promise<ReminderView> {
    if (this.maxReminders !== undefined && (await this.repo.countActive()) >= this.maxReminders) {
      throw new ValidationError(`演示环境最多创建 ${this.maxReminders} 条提醒，请删除部分提醒后再试`);
    }
    const globalTimezone = await this.settings.getGlobalTimezone();
    const { input, startsAt } = validateReminderInput(raw, globalTimezone);
    await this.ensureChannelsExist(input.channelIds);

    const id = randomUuid();
    const now = Date.now();
    const stmts = this.repo.insertStatements(
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
    await this.db.batch(stmts);
    return this.getById(id);
  }

  async update(id: string, raw: unknown): Promise<ReminderView> {
    const globalTimezone = await this.settings.getGlobalTimezone();
    const { input, startsAt } = validateReminderInput(raw, globalTimezone);
    const existing = await this.repo.findById(id);
    if (!existing) throw notFound('提醒不存在');
    await this.ensureChannelsExist(input.channelIds);

    const scheduleChanged =
      existing.starts_at !== startsAt
      || existing.timezone !== input.timezone
      || existing.is_repeating !== (input.isRepeating ? 1 : 0)
      || existing.repeat_every !== input.repeatEvery
      || existing.repeat_unit !== input.repeatUnit;

    const nextEnabled = scheduleChanged && existing.completed === 1 ? 1 : existing.enabled;
    const nextCompleted = scheduleChanged ? 0 : existing.completed;
    const nextRunAt = scheduleChanged ? startsAt : existing.next_run_at;

    const stmts = this.repo.updateStatements(
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
    const results = await this.db.batch(stmts);
    if ((results[0]?.changes ?? 0) === 0) {
      throw notFound('提醒不存在');
    }
    return this.getById(id);
  }

  async softDelete(id: string): Promise<void> {
    const results = await this.db.batch(this.repo.softDeleteStatements(id, Date.now()));
    if ((results[0]?.changes ?? 0) === 0) {
      throw notFound('提醒不存在');
    }
  }

  async enable(id: string, now = Date.now()): Promise<ReminderView> {
    const row = await this.repo.findById(id);
    if (!row) throw notFound('提醒不存在');
    if (row.completed === 1) {
      throw new ValidationError('已完成的提醒需要编辑时间后重新安排');
    }
    let nextRunAt = row.next_run_at;
    if (nextRunAt <= now) {
      if (row.is_repeating === 1 && row.repeat_every && row.repeat_unit) {
        const timezone = row.timezone ?? (await this.settings.getGlobalTimezone());
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
    await this.db.run(this.repo.setEnabledAndNextRunStatement(id, 1, nextRunAt, now));
    return this.getById(id);
  }

  async disable(id: string, now = Date.now()): Promise<ReminderView> {
    const row = await this.repo.findById(id);
    if (!row) throw notFound('提醒不存在');
    await this.db.run(this.repo.setEnabledAndNextRunStatement(id, 0, row.next_run_at, now));
    return this.getById(id);
  }

  /**
   * Executes batch enable/disable/delete/replace-channels atomically in a single `db.batch()`,
   * safely chunking `IN` queries and multi-row inserts for D1's 100-parameter limit.
   */
  async batch(raw: unknown, now = Date.now()): Promise<ReminderBatchResult> {
    const input = validateReminderBatchInput(raw);

    if (input.action === 'channels') {
      await this.ensureChannelsExist(input.channelIds);
      const rows = await this.repo.findByIds(input.ids);
      const validIds = new Set(rows.map((r) => r.id));
      const stmts: SqlStatement[] = [];
      const updateResultIndices: number[] = [];
      for (const id of input.ids) {
        if (!validIds.has(id)) continue;
        updateResultIndices.push(stmts.length);
        stmts.push(...this.repo.replaceChannelsStatements(id, input.channelIds, now));
      }
      if (!stmts.length) return { updated: 0, skipped: input.ids.length };
      const results = await this.db.batch(stmts);
      let updated = 0;
      for (const idx of updateResultIndices) {
        if ((results[idx]?.changes ?? 0) > 0) updated += 1;
      }
      return { updated, skipped: input.ids.length - updated };
    }

    if (input.action === 'delete') {
      const rows = await this.repo.findByIds(input.ids);
      const validIds = new Set(rows.map((r) => r.id));
      const stmts: SqlStatement[] = [];
      const updateResultIndices: number[] = [];
      for (const id of input.ids) {
        if (!validIds.has(id)) continue;
        updateResultIndices.push(stmts.length);
        stmts.push(...this.repo.softDeleteStatements(id, now));
      }
      if (!stmts.length) return { updated: 0, skipped: input.ids.length };
      const results = await this.db.batch(stmts);
      let updated = 0;
      for (const idx of updateResultIndices) {
        if ((results[idx]?.changes ?? 0) > 0) updated += 1;
      }
      return { updated, skipped: input.ids.length - updated };
    }

    const [rows, globalTimezone] = await Promise.all([
      this.repo.findByIds(input.ids),
      this.settings.getGlobalTimezone(),
    ]);
    const rowMap = new Map(rows.map((r) => [r.id, r]));
    const stmts: SqlStatement[] = [];

    for (const id of input.ids) {
      const row = rowMap.get(id);
      if (!row) continue;

      if (input.action === 'disable') {
        if (row.enabled === 0) continue;
        stmts.push(this.repo.setEnabledAndNextRunStatement(id, 0, row.next_run_at, now));
        continue;
      }

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
          continue;
        }
      }
      stmts.push(this.repo.setEnabledAndNextRunStatement(id, 1, nextRunAt, now));
    }

    if (!stmts.length) return { updated: 0, skipped: input.ids.length };
    const results = await this.db.batch(stmts);
    const updated = results.reduce((sum, res) => sum + ((res.changes ?? 0) > 0 ? 1 : 0), 0);
    return { updated, skipped: input.ids.length - updated };
  }

  async test(raw: unknown): Promise<ReminderTestResult[]> {
    const globalTimezone = await this.settings.getGlobalTimezone();
    const { input, startsAt, effectiveTimezone } = validateReminderInput(raw, globalTimezone);
    const maxTest = this.maxTestChannels ?? 100;
    if (input.channelIds.length > maxTest) {
      throw new ValidationError(`一次最多测试 ${maxTest} 个通知渠道`);
    }

    const channels = await Promise.all(input.channelIds.map((id) => this.channelsService.getInternal(id)));
    if (channels.some((c) => !c)) {
      throw new ValidationError('通知渠道不存在，请刷新后重试');
    }

    const message: NotificationMessage = {
      eventId: randomUuid(),
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
        results.push({
          channelId: channel.id,
          channelName: channel.name,
          ok: false,
          error: '请先填写并保存完整渠道配置',
        });
        continue;
      }
      const resolvedProxy = await this.proxies.resolveForChannel(channel.proxyId);
      if (resolvedProxy.error) {
        results.push({ channelId: channel.id, channelName: channel.name, ok: false, error: resolvedProxy.error });
        continue;
      }
      const res = await provider.send(message, channel.config, { proxy: resolvedProxy.target });
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
