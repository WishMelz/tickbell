import { Injectable } from '@nestjs/common';
import { conflict, notFound } from '../../common/errors';
import { epochToIso } from '../../common/time';
import { ChannelsService } from '../channels/channels.service';
import type { NotificationMessage } from '../notifications/channel-provider.interface';
import { ChannelRegistry } from '../notifications/channel-registry.service';
import { runWithProxyContext } from '../notifications/http/proxy-dispatcher';
import { ProxiesService } from '../proxies/proxies.service';
import { RemindersRepository } from '../reminders/reminders.repository';
import { SettingsService } from '../settings/settings.service';
import {
  DELIVERY_STATUSES,
  type DeliveryJoinedRow,
  type DeliveryRow,
  DeliveriesRepository,
  type DeliveryStatus,
} from './deliveries.repository';

export interface DeliveryView {
  id: string;
  eventId: string;
  reminderId: string;
  reminderTitle: string;
  scheduledAt: string;
  channelId: string;
  channelName: string;
  channelType: string;
  status: DeliveryStatus;
  attempts: number;
  nextRetryAt: string | null;
  httpStatus: number | null;
  error: string | null;
  responseSummary: string | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryPage {
  items: DeliveryView[];
  total: number;
  page: number;
  pageSize: number;
}

/** Retry delays (ms) for up to 3 automatic retries: 1 min → 5 min → 15 min (plan 3.2). */
export const RETRY_BACKOFF_MS: readonly number[] = [
  1 * 60 * 1000,
  5 * 60 * 1000,
  15 * 60 * 1000,
];

@Injectable()
export class DeliveriesService {
  constructor(
    private readonly repo: DeliveriesRepository,
    private readonly channelsService: ChannelsService,
    private readonly remindersRepo: RemindersRepository,
    private readonly registry: ChannelRegistry,
    private readonly proxies: ProxiesService,
    private readonly settings: SettingsService,
  ) {}

  toView(row: DeliveryJoinedRow): DeliveryView {
    return {
      id: row.id,
      eventId: row.event_id,
      reminderId: row.reminder_id,
      reminderTitle: row.reminder_title,
      scheduledAt: epochToIso(row.scheduled_at),
      channelId: row.channel_id,
      channelName: row.channel_name,
      channelType: row.channel_type,
      status: row.status,
      attempts: row.attempts,
      nextRetryAt: row.next_retry_at ? epochToIso(row.next_retry_at) : null,
      httpStatus: row.http_status,
      error: row.error,
      responseSummary: row.response_summary,
      sentAt: row.sent_at ? epochToIso(row.sent_at) : null,
      createdAt: epochToIso(row.created_at),
      updatedAt: epochToIso(row.updated_at),
    };
  }

  listPage(raw: {
    reminderId?: string;
    channelId?: string;
    status?: string;
    page?: string;
    pageSize?: string;
  }): DeliveryPage {
    const pageNum = Number.parseInt(raw.page ?? '1', 10);
    const sizeNum = Number.parseInt(raw.pageSize ?? '20', 10);
    const page = Number.isFinite(pageNum) && pageNum >= 1 ? pageNum : 1;
    const pageSize = Number.isFinite(sizeNum) ? Math.min(100, Math.max(1, sizeNum)) : 20;
    const status =
      raw.status && (DELIVERY_STATUSES as readonly string[]).includes(raw.status)
        ? (raw.status as DeliveryStatus)
        : undefined;

    const { items, total } = this.repo.findPage({
      reminderId: raw.reminderId?.trim() || undefined,
      channelId: raw.channelId?.trim() || undefined,
      status,
      page,
      pageSize,
    });
    return {
      items: items.map((row) => this.toView(row)),
      total,
      page,
      pageSize,
    };
  }

  /**
   * Executes one delivery attempt outside any DB transaction, writes back `sent`, `retrying`, or `failed`.
   */
  async executeDelivery(params: {
    deliveryId: string;
    eventId: string;
    reminderId: string;
    title: string;
    content: string;
    contentHtml: string | null;
    timezone: string;
    scheduledAt: number;
    channelId: string;
    previousAttempts: number;
    isLate: boolean;
    allowAutoRetry: boolean;
    now?: number;
  }): Promise<void> {
    const startedAt = params.now ?? Date.now();
    const channel = this.channelsService.getInternal(params.channelId);
    if (!channel) {
      this.repo.markFailedWithoutAttempt(params.deliveryId, '通知渠道不存在', startedAt);
      return;
    }

    const provider = this.registry.get(channel.type);
    if (!provider) {
      this.repo.markFailedWithoutAttempt(params.deliveryId, '渠道类型暂不支持', startedAt);
      return;
    }

    if (!channel.enabled || !channel.config || !provider.isConfigured(channel.config)) {
      this.repo.markFailedWithoutAttempt(params.deliveryId, '通知渠道未启用或尚未配置', startedAt);
      return;
    }

    const resolvedProxy = this.proxies.resolveForChannel(channel.proxyId);
    if (resolvedProxy.error) {
      this.repo.markFailedWithoutAttempt(params.deliveryId, resolvedProxy.error, startedAt);
      return;
    }

    const message: NotificationMessage = {
      eventId: params.eventId,
      reminderId: params.reminderId,
      title: params.title,
      content: params.content,
      contentHtml: params.contentHtml,
      timezone: params.timezone,
      scheduledAt: params.scheduledAt,
      triggeredAt: startedAt,
      isLate: params.isLate,
    };

    const result = await runWithProxyContext(resolvedProxy.target, () => provider.send(message, channel.config!));
    const finishedAt = params.now ?? Date.now();

    if (result.ok) {
      this.repo.recordAttemptResult({
        id: params.deliveryId,
        status: 'sent',
        nextRetryAt: null,
        httpStatus: result.httpStatus,
        error: null,
        responseSummary: result.responseSummary,
        sentAt: finishedAt,
        now: finishedAt,
      });
      return;
    }

    // Attempt count after this failure: previousAttempts + 1.
    // Backoff index 0 = after 1st attempt (1 min), index 1 = after 2nd (5 min), index 2 = after 3rd (15 min).
    const backoffDelay =
      params.allowAutoRetry && result.errorClass === 'retryable'
        ? RETRY_BACKOFF_MS[params.previousAttempts]
        : undefined;

    if (backoffDelay !== undefined) {
      this.repo.recordAttemptResult({
        id: params.deliveryId,
        status: 'retrying',
        nextRetryAt: finishedAt + backoffDelay,
        httpStatus: result.httpStatus,
        error: result.error,
        responseSummary: result.responseSummary,
        sentAt: null,
        now: finishedAt,
      });
    } else {
      this.repo.recordAttemptResult({
        id: params.deliveryId,
        status: 'failed',
        nextRetryAt: null,
        httpStatus: result.httpStatus,
        error: result.error,
        responseSummary: result.responseSummary,
        sentAt: null,
        now: finishedAt,
      });
    }
  }

  /** Re-attempts a scheduled `retrying` row during a scheduler tick. */
  async executeScheduledRetry(row: DeliveryRow, now = Date.now()): Promise<void> {
    const reminder = this.remindersRepo.findById(row.reminder_id, true);
    if (!reminder) {
      this.repo.markFailedWithoutAttempt(row.id, '关联提醒不存在', now);
      return;
    }
    const timezone = reminder.timezone ?? this.settings.getGlobalTimezone();
    await this.executeDelivery({
      deliveryId: row.id,
      eventId: row.event_id,
      reminderId: row.reminder_id,
      title: reminder.title,
      content: reminder.content,
      contentHtml: reminder.content_html,
      timezone,
      scheduledAt: row.scheduled_at,
      channelId: row.channel_id,
      previousAttempts: row.attempts,
      isLate: now - row.scheduled_at > 60_000,
      allowAutoRetry: true,
      now,
    });
  }

  /** Manual retry from API (`POST /api/deliveries/:id/retry`): only allowed for `failed` status. */
  async manualRetry(id: string): Promise<DeliveryView> {
    const existing = this.repo.findJoinedById(id);
    if (!existing) throw notFound('发送日志不存在');
    if (existing.status !== 'failed') {
      throw conflict('只有失败状态的投递才能手动重试');
    }

    const reminder = this.remindersRepo.findById(existing.reminder_id, true);
    if (!reminder) throw notFound('关联提醒不存在');

    const timezone = reminder.timezone ?? this.settings.getGlobalTimezone();
    const now = Date.now();
    await this.executeDelivery({
      deliveryId: existing.id,
      eventId: existing.event_id,
      reminderId: existing.reminder_id,
      title: reminder.title,
      content: reminder.content,
      contentHtml: reminder.content_html,
      timezone,
      scheduledAt: existing.scheduled_at,
      channelId: existing.channel_id,
      previousAttempts: existing.attempts,
      isLate: now - existing.scheduled_at > 60_000,
      allowAutoRetry: false,
    });

    const updated = this.repo.findJoinedById(id);
    if (!updated) throw notFound('发送日志不存在');
    return this.toView(updated);
  }
}
