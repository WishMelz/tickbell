import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { payloadTooLarge, ValidationError } from '../../common/errors';
import {
  CONTENT_HTML_LIMIT,
  CONTENT_TEXT_LIMIT,
  contentHtmlToText,
  sanitizeContentHtml,
} from '../../common/reminder-content';
import { isValidTimezone } from '../../common/time';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { DatabaseService } from '../database/database.service';
import { ChannelRegistry } from '../notifications/channel-registry.service';
import { PrivateNetworkPolicy } from '../notifications/http/url-policy';
import { SchedulerService } from '../scheduler/scheduler.service';
import {
  INTERNAL_SETTING_KEYS,
  SETTING_AUTH_PASSWORD_HASH,
  SETTING_AUTH_SESSION_SECRET,
  SettingsService,
} from '../settings/settings.service';

export const MAX_BACKUP_BYTES = 32 * 1024 * 1024;

const identifier = z.string().min(1).max(128);
const timestamp = z.number().int().min(-8640000000000000).max(8640000000000000);
const flag = z.union([z.literal(0), z.literal(1)]);
const timezone = z.string().refine(isValidTimezone);

const settingSchema = z.strictObject({
  key: z.string().min(1).max(128),
  value: z.string(),
  updated_at: timestamp,
});

const reminderSchema = z.strictObject({
  id: identifier,
  title: z.string().min(1).max(120),
  content: z.string().max(CONTENT_TEXT_LIMIT),
  content_html: z.string().max(CONTENT_HTML_LIMIT).nullable(),
  category: z.string().max(80),
  tags: z.string(),
  timezone: timezone.nullable(),
  starts_at: timestamp,
  next_run_at: timestamp,
  is_repeating: flag,
  repeat_every: z.number().int().min(1).max(9999).nullable(),
  repeat_unit: z.enum(['minute', 'hour', 'day', 'month', 'year']).nullable(),
  enabled: flag,
  completed: flag,
  deleted_at: timestamp.nullable(),
  created_at: timestamp,
  updated_at: timestamp,
  schedule_version: z.number().int().nonnegative(),
});

const channelV1Schema = z.strictObject({
  id: identifier,
  name: z.string().min(1).max(80),
  type: z.string().min(1).max(64),
  enabled: flag,
  config: z.string().nullable(),
  legacy_encrypted_config: z.null().optional(),
  created_at: timestamp,
  updated_at: timestamp,
});

const channelV2Schema = z.strictObject({
  id: identifier,
  name: z.string().min(1).max(80),
  type: z.string().min(1).max(64),
  enabled: flag,
  config: z.string().nullable(),
  created_at: timestamp,
  updated_at: timestamp,
});

const reminderChannelSchema = z.strictObject({
  reminder_id: identifier,
  channel_id: identifier,
});

const deliveryV1Schema = z.strictObject({
  id: identifier,
  event_id: identifier,
  reminder_id: identifier,
  scheduled_at: timestamp,
  channel_id: identifier,
  status: z.enum(['pending', 'sent', 'failed']),
  attempts: z.number().int().nonnegative(),
  http_status: z.number().int().nullable(),
  error: z.string().nullable(),
  response_summary: z.string().nullable(),
  sent_at: timestamp.nullable(),
  created_at: timestamp,
  updated_at: timestamp,
});

const deliveryV2Schema = z.strictObject({
  id: identifier,
  event_id: identifier,
  reminder_id: identifier,
  scheduled_at: timestamp,
  channel_id: identifier,
  status: z.enum(['pending', 'sent', 'failed', 'retrying', 'skipped']),
  attempts: z.number().int().nonnegative(),
  next_retry_at: timestamp.nullable(),
  http_status: z.number().int().nullable(),
  error: z.string().nullable(),
  response_summary: z.string().nullable(),
  sent_at: timestamp.nullable(),
  created_at: timestamp,
  updated_at: timestamp,
});

const receiptSchema = z.strictObject({
  reminder_id: identifier,
  scheduled_at: timestamp,
  channel_id: identifier,
});

const backupV1Schema = z.strictObject({
  format: z.literal('tips-full-backup'),
  version: z.literal(1),
  exportedAt: z.iso.datetime(),
  settings: z.array(settingSchema),
  reminders: z.array(reminderSchema),
  channels: z.array(channelV1Schema),
  reminderChannels: z.array(reminderChannelSchema),
  deliveries: z.array(deliveryV1Schema),
  receipts: z.array(receiptSchema),
});

const backupV2Schema = z.strictObject({
  format: z.enum(['tickbell-full-backup', 'tips-full-backup']),
  version: z.literal(2),
  exportedAt: z.iso.datetime(),
  settings: z.array(settingSchema),
  reminders: z.array(reminderSchema),
  channels: z.array(channelV2Schema),
  reminderChannels: z.array(reminderChannelSchema),
  deliveries: z.array(deliveryV2Schema),
  receipts: z.array(receiptSchema),
});

export type FullBackupV2 = z.infer<typeof backupV2Schema>;

interface NormalizedBackup {
  sourceVersion: 1 | 2;
  exportedAt: string;
  settings: Array<z.infer<typeof settingSchema>>;
  reminders: Array<z.infer<typeof reminderSchema>>;
  channels: Array<z.infer<typeof channelV2Schema>>;
  reminderChannels: Array<z.infer<typeof reminderChannelSchema>>;
  deliveries: Array<z.infer<typeof deliveryV2Schema>>;
  receipts: Array<z.infer<typeof receiptSchema>>;
}

export interface BackupPreview {
  reminders: number;
  activeReminders: number;
  deletedReminders: number;
  channels: number;
  unsupportedChannels: number;
  deliveries: number;
  pendingDeliveries: number;
  globalTimezone: string;
  exportedAt: string;
  sourceVersion: 1 | 2;
  remindersWithoutUsableChannel: Array<{ id: string; title: string }>;
}

function assertUnique(values: string[], label: string): Set<string> {
  const set = new Set(values);
  if (set.size !== values.length) throw new ValidationError(`备份存在重复${label}`);
  return set;
}

function receiptKey(row: { reminder_id: string; scheduled_at: number; channel_id: string }): string {
  return JSON.stringify([row.reminder_id, row.scheduled_at, row.channel_id]);
}

@Injectable()
export class BackupService {
  private readonly policy: PrivateNetworkPolicy;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly database: DatabaseService,
    private readonly registry: ChannelRegistry,
    private readonly scheduler: SchedulerService,
    private readonly settings: SettingsService,
  ) {
    this.policy = new PrivateNetworkPolicy(config.allowedPrivateHosts, config.allowPrivateUrls);
  }

  validate(value: unknown): NormalizedBackup {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ValidationError('全量备份格式、版本或字段无效');
    }

    const version = (value as Record<string, unknown>).version;
    let normalized: NormalizedBackup;

    if (version === 1) {
      const parsed = backupV1Schema.safeParse(value);
      if (!parsed.success) throw new ValidationError('全量备份格式、版本或字段无效');
      const d = parsed.data;
      normalized = {
        sourceVersion: 1,
        exportedAt: d.exportedAt,
        settings: d.settings,
        reminders: d.reminders,
        channels: d.channels.map((ch) => ({
          id: ch.id,
          name: ch.name,
          type: ch.type,
          enabled: ch.enabled,
          config: ch.config,
          created_at: ch.created_at,
          updated_at: ch.updated_at,
        })),
        reminderChannels: d.reminderChannels,
        deliveries: d.deliveries.map((del) => ({
          ...del,
          next_retry_at: null,
        })),
        receipts: d.receipts,
      };
    } else if (version === 2) {
      const parsed = backupV2Schema.safeParse(value);
      if (!parsed.success) throw new ValidationError('全量备份格式、版本或字段无效');
      const d = parsed.data;
      normalized = {
        sourceVersion: 2,
        exportedAt: d.exportedAt,
        settings: d.settings,
        reminders: d.reminders,
        channels: d.channels,
        reminderChannels: d.reminderChannels,
        deliveries: d.deliveries,
        receipts: d.receipts,
      };
    } else {
      throw new ValidationError('全量备份格式、版本或字段无效');
    }

    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_BACKUP_BYTES) {
      throw payloadTooLarge('备份超过 32 MB，请使用服务器 SQLite 文件备份恢复');
    }

    assertUnique(normalized.settings.map((r) => r.key), '设置');
    const globalTimezone = normalized.settings.find((r) => r.key === 'global_timezone')?.value;
    if (!globalTimezone || !isValidTimezone(globalTimezone)) {
      throw new ValidationError('备份全局时区无效');
    }

    const activeCount = normalized.reminders.filter((r) => r.deleted_at === null).length;
    if (activeCount > this.config.maxReminders) {
      throw new ValidationError(`未删除提醒不能超过 ${this.config.maxReminders} 条`);
    }

    const reminderIds = assertUnique(normalized.reminders.map((r) => r.id), '提醒 ID');
    const channelIds = assertUnique(normalized.channels.map((r) => r.id), '渠道 ID');
    assertUnique(normalized.deliveries.map((r) => r.id), '日志 ID');
    assertUnique(normalized.deliveries.map((r) => r.event_id), '事件 ID');
    assertUnique(normalized.deliveries.map(receiptKey), '投递幂等键');
    assertUnique(normalized.receipts.map(receiptKey), '去重凭据');
    assertUnique(
      normalized.reminderChannels.map((r) => JSON.stringify([r.reminder_id, r.channel_id])),
      '渠道关联',
    );

    for (const row of [...normalized.reminderChannels, ...normalized.deliveries]) {
      if (!reminderIds.has(row.reminder_id) || !channelIds.has(row.channel_id)) {
        throw new ValidationError('备份关联或日志引用不存在的提醒或渠道');
      }
    }

    for (const row of normalized.reminders) {
      let tags: unknown;
      try {
        tags = JSON.parse(row.tags);
      } catch {
        throw new ValidationError('备份标签无效');
      }
      if (
        !Array.isArray(tags)
        || tags.length > 10
        || tags.some((tag) => typeof tag !== 'string' || !tag.trim() || tag.length > 30)
        || new Set(tags).size !== tags.length
      ) {
        throw new ValidationError('备份标签无效');
      }
      if (
        !row.title.trim()
        || row.next_run_at < row.starts_at
        || (row.is_repeating === 0 && (row.repeat_every !== null || row.repeat_unit !== null || row.next_run_at !== row.starts_at))
        || (row.is_repeating === 1 && (row.repeat_every === null || row.repeat_unit === null))
      ) {
        throw new ValidationError('备份提醒时间或重复规则无效');
      }
      if (row.content_html !== null) {
        row.content_html = sanitizeContentHtml(row.content_html);
        row.content = contentHtmlToText(row.content_html);
        if (row.content.length > CONTENT_TEXT_LIMIT || row.content_html.length > CONTENT_HTML_LIMIT) {
          throw new ValidationError('备份提醒正文过长');
        }
      }
    }

    for (const row of normalized.channels) {
      if (!row.name.trim()) throw new ValidationError('备份渠道名称无效');
      if (row.config === null) continue;
      let parsedConfig: unknown;
      try {
        parsedConfig = JSON.parse(row.config);
      } catch {
        throw new ValidationError('备份渠道配置无效');
      }
      if (!parsedConfig || typeof parsedConfig !== 'object' || Array.isArray(parsedConfig)) {
        throw new ValidationError('备份渠道配置无效');
      }
      const provider = this.registry.get(row.type);
      if (provider) {
        if (!provider.configSchema.safeParse(parsedConfig).success) {
          throw new ValidationError(`备份中渠道“${row.name}”的配置无效`);
        }
        // Validate URL rules (SSRF policy) for supported channels
        provider.mergeConfig(parsedConfig, null, row.enabled === 1, this.policy);
      }
    }

    return normalized;
  }

  preview(rawBackup: unknown): BackupPreview {
    const backup = this.validate(rawBackup);

    const usableChannelIds = new Set<string>();
    let unsupportedChannels = 0;

    for (const ch of backup.channels) {
      const provider = this.registry.get(ch.type);
      if (!provider) {
        unsupportedChannels += 1;
        continue;
      }
      if (ch.config) {
        try {
          const parsed = JSON.parse(ch.config) as Record<string, unknown>;
          if (provider.isConfigured(parsed)) {
            usableChannelIds.add(ch.id);
          }
        } catch {
          // not usable
        }
      }
    }

    const linksByReminder = new Map<string, string[]>();
    for (const link of backup.reminderChannels) {
      const arr = linksByReminder.get(link.reminder_id);
      if (arr) arr.push(link.channel_id);
      else linksByReminder.set(link.reminder_id, [link.channel_id]);
    }

    const remindersWithoutUsableChannel: Array<{ id: string; title: string }> = [];
    for (const r of backup.reminders) {
      if (r.deleted_at !== null) continue;
      const linked = linksByReminder.get(r.id) ?? [];
      const hasUsable = linked.some((cid) => usableChannelIds.has(cid));
      if (!hasUsable) {
        remindersWithoutUsableChannel.push({ id: r.id, title: r.title });
      }
    }

    return {
      reminders: backup.reminders.length,
      activeReminders: backup.reminders.filter((r) => r.deleted_at === null).length,
      deletedReminders: backup.reminders.filter((r) => r.deleted_at !== null).length,
      channels: backup.channels.length,
      unsupportedChannels,
      deliveries: backup.deliveries.length,
      pendingDeliveries: backup.deliveries.filter((d) => d.status === 'pending' || d.status === 'retrying').length,
      globalTimezone: backup.settings.find((s) => s.key === 'global_timezone')!.value,
      exportedAt: backup.exportedAt,
      sourceVersion: backup.sourceVersion,
      remindersWithoutUsableChannel,
    };
  }

  export(): FullBackupV2 {
    const snapshot = this.database.transaction(() => {
      const settings = (
        this.database.db.prepare('SELECT key, value, updated_at FROM settings').all() as Array<
          z.infer<typeof settingSchema>
        >
      ).filter((row) => !INTERNAL_SETTING_KEYS.has(row.key));

      const reminders = this.database.db
        .prepare('SELECT * FROM reminders')
        .all() as Array<z.infer<typeof reminderSchema>>;

      const channels = this.database.db
        .prepare('SELECT id, name, type, enabled, config, created_at, updated_at FROM channels')
        .all() as Array<z.infer<typeof channelV2Schema>>;

      const reminderChannels = this.database.db
        .prepare('SELECT reminder_id, channel_id FROM reminder_channels')
        .all() as Array<z.infer<typeof reminderChannelSchema>>;

      const deliveries = this.database.db
        .prepare('SELECT * FROM deliveries')
        .all() as Array<z.infer<typeof deliveryV2Schema>>;

      const receipts = this.database.db
        .prepare('SELECT reminder_id, scheduled_at, channel_id FROM delivery_receipts')
        .all() as Array<z.infer<typeof receiptSchema>>;

      return {
        format: 'tickbell-full-backup' as const,
        version: 2 as const,
        exportedAt: new Date().toISOString(),
        settings,
        reminders,
        channels,
        reminderChannels,
        deliveries,
        receipts,
      };
    });

    // Self-check exported payload
    this.validate(snapshot);
    return snapshot;
  }

  async restore(rawBackup: unknown): Promise<void> {
    const backup = this.validate(rawBackup);

    await this.scheduler.pause();
    try {
      const now = Date.now();
      this.database.transaction(() => {
        const db = this.database.db;
        // Preserve this server's admin password hash & session secret across business backup restores
        const preservedPasswordHash = this.settings.getAuthPasswordHash();
        const preservedSessionSecret = this.settings.getAuthSessionSecret();

        // Clear business tables (keep existing `delivery_receipts` so receipts merge!)
        db.prepare('DELETE FROM deliveries').run();
        db.prepare('DELETE FROM reminder_channels').run();
        db.prepare('DELETE FROM reminders').run();
        db.prepare('DELETE FROM channels').run();
        db.prepare('DELETE FROM settings').run();

        const insertSetting = db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
        for (const s of backup.settings) {
          if (INTERNAL_SETTING_KEYS.has(s.key)) continue;
          insertSetting.run(s.key, s.value, s.updated_at);
        }
        if (preservedPasswordHash) {
          insertSetting.run(SETTING_AUTH_PASSWORD_HASH, preservedPasswordHash, now);
        }
        if (preservedSessionSecret) {
          insertSetting.run(SETTING_AUTH_SESSION_SECRET, preservedSessionSecret, now);
        }
        // Rotate session generation to invalidate all existing sessions
        this.settings.rotateSessionGeneration(now);

        const insertChannel = db.prepare(
          'INSERT INTO channels (id, name, type, enabled, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        );
        for (const ch of backup.channels) {
          const supported = this.registry.has(ch.type);
          insertChannel.run(
            ch.id,
            ch.name,
            ch.type,
            supported ? ch.enabled : 0, // Unsupported types forced disabled
            ch.config,
            ch.created_at,
            ch.updated_at,
          );
        }

        const insertReminder = db.prepare(
          `INSERT INTO reminders (
             id, title, content, content_html, category, tags, timezone,
             starts_at, is_repeating, repeat_every, repeat_unit,
             enabled, completed, next_run_at, schedule_version, deleted_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const r of backup.reminders) {
          insertReminder.run(
            r.id,
            r.title,
            r.content,
            r.content_html,
            r.category,
            r.tags,
            r.timezone,
            r.starts_at,
            r.is_repeating,
            r.repeat_every,
            r.repeat_unit,
            0, // Safety rule: all restored reminders start paused
            r.completed,
            r.next_run_at,
            r.schedule_version,
            r.deleted_at,
            r.created_at,
            r.updated_at,
          );
        }

        const insertLink = db.prepare('INSERT INTO reminder_channels (reminder_id, channel_id) VALUES (?, ?)');
        for (const link of backup.reminderChannels) {
          insertLink.run(link.reminder_id, link.channel_id);
        }

        const insertDelivery = db.prepare(
          `INSERT INTO deliveries (
             id, event_id, reminder_id, scheduled_at, channel_id, status, attempts,
             next_retry_at, http_status, error, response_summary, sent_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const insertReceipt = db.prepare(
          'INSERT OR IGNORE INTO delivery_receipts (reminder_id, scheduled_at, channel_id) VALUES (?, ?, ?)',
        );

        for (const d of backup.deliveries) {
          const ambiguous = d.status === 'pending' || d.status === 'retrying';
          insertDelivery.run(
            d.id,
            d.event_id,
            d.reminder_id,
            d.scheduled_at,
            d.channel_id,
            ambiguous ? 'failed' : d.status,
            d.attempts,
            ambiguous ? null : d.next_retry_at,
            d.http_status,
            ambiguous ? '恢复时状态未知，已停止自动重发' : d.error,
            d.response_summary,
            d.sent_at,
            d.created_at,
            ambiguous ? now : d.updated_at,
          );
          insertReceipt.run(d.reminder_id, d.scheduled_at, d.channel_id);
        }

        for (const receipt of backup.receipts) {
          insertReceipt.run(receipt.reminder_id, receipt.scheduled_at, receipt.channel_id);
        }
      });
    } finally {
      this.scheduler.resume();
    }
  }
}
