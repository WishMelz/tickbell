import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { notFound, notImplemented, payloadTooLarge, ValidationError } from '../common/errors';
import {
  CONTENT_HTML_LIMIT,
  CONTENT_TEXT_LIMIT,
  contentHtmlToText,
  sanitizeContentHtml,
} from '../common/reminder-content';
import { calculateNextFutureRun } from '../common/repeat';
import { epochToIso, isValidTimezone } from '../common/time';
import { randomUuid } from '../crypto/index';
import { buildMultiRowInsertStatements, utf8ByteLength } from '../db/chunking';
import type { ChannelRegistry } from '../notifications/channel-registry';
import type { PrivateNetworkPolicy } from '../notifications/http/url-policy';
import type {
  AutoBackupFileInfo,
  AutoBackupStorage,
  CoreLogger,
  DbAdapter,
  SqlStatement,
} from '../ports/index';
import type { SettingsRepository } from '../repositories/settings.repository';
import {
  INTERNAL_SETTING_KEYS,
  SETTING_AUTH_PASSWORD_HASH,
  SETTING_AUTH_SESSION_SECRET,
  SETTING_AUTO_BACKUP_CONFIG,
  SETTING_AUTO_BACKUP_STATE,
  SETTING_CRON_HEARTBEAT,
  SETTING_LAST_CLEANUP_AT,
  SETTING_SESSION_GENERATION,
  type SettingsService,
} from './settings.service';

export const MAX_BACKUP_BYTES = 32 * 1024 * 1024;
export const AUTO_BACKUP_INTERVAL_UNITS = ['hour', 'day'] as const;
export type AutoBackupIntervalUnit = (typeof AUTO_BACKUP_INTERVAL_UNITS)[number];

export interface AutoBackupConfig {
  enabled: boolean;
  time: string;
  intervalEvery: number;
  intervalUnit: AutoBackupIntervalUnit;
  maxFiles: number;
}

interface AutoBackupStateInternal {
  lastRunAt: number | null;
  lastFile: string | null;
  nextRunAt: number | null;
  lastError: string | null;
  timezone: string | null;
}

export interface AutoBackupView {
  config: AutoBackupConfig;
  state: {
    lastRunAt: string | null;
    lastFile: string | null;
    nextRunAt: string | null;
    lastError: string | null;
  };
  timezone: string;
  backupDir: string;
  files: AutoBackupFileInfo[];
}

const DEFAULT_AUTO_BACKUP_CONFIG: AutoBackupConfig = {
  enabled: false,
  time: '03:00',
  intervalEvery: 1,
  intervalUnit: 'day',
  maxFiles: 10,
};

const TIME_HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const AUTO_BACKUP_FILE_RE = /^tickbell-auto-\d{8}-\d{6}\.json$/;

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

const proxySchema = z.strictObject({
  id: identifier,
  name: z.string().min(1).max(80),
  protocol: z.enum(['http', 'https', 'socks5']),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().max(128),
  password: z.string().max(256),
  enabled: flag,
  created_at: timestamp,
  updated_at: timestamp,
});

const channelV2Schema = z.strictObject({
  id: identifier,
  name: z.string().min(1).max(80),
  type: z.string().min(1).max(64),
  enabled: flag,
  config: z.string().nullable(),
  proxy_id: identifier.nullable().optional(),
  created_at: timestamp,
  updated_at: timestamp,
});

const reminderChannelSchema = z.strictObject({
  reminder_id: identifier,
  channel_id: identifier,
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

const backupV2Schema = z.strictObject({
  format: z.literal('tickbell-full-backup'),
  version: z.literal(2),
  exportedAt: z.iso.datetime(),
  settings: z.array(settingSchema),
  proxies: z.array(proxySchema).optional(),
  reminders: z.array(reminderSchema),
  channels: z.array(channelV2Schema),
  reminderChannels: z.array(reminderChannelSchema),
  deliveries: z.array(deliveryV2Schema).optional(),
  receipts: z.array(receiptSchema).optional(),
});

export interface FullBackupExport {
  format: 'tickbell-full-backup';
  version: 2;
  exportedAt: string;
  settings: Array<z.infer<typeof settingSchema>>;
  proxies: Array<z.infer<typeof proxySchema>>;
  reminders: Array<z.infer<typeof reminderSchema>>;
  channels: Array<z.infer<typeof channelV2Schema>>;
  reminderChannels: Array<z.infer<typeof reminderChannelSchema>>;
}

interface NormalizedBackup {
  sourceVersion: 2;
  exportedAt: string;
  settings: Array<z.infer<typeof settingSchema>>;
  proxies: Array<z.infer<typeof proxySchema>>;
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
  sourceVersion: 2;
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

export interface SchedulerPauseHooks {
  pause(): Promise<void>;
  resume(): void;
}

export class BackupService {
  private autoBackupRunning = false;
  private restoring = false;

  constructor(
    private readonly db: DbAdapter,
    private readonly policy: PrivateNetworkPolicy,
    private readonly registry: ChannelRegistry,
    private readonly settings: SettingsService,
    private readonly settingsRepo: SettingsRepository,
    private readonly logger: CoreLogger,
    private readonly autoBackupStorage?: AutoBackupStorage,
    private readonly schedulerHooks?: SchedulerPauseHooks,
  ) {}

  private assertAutoBackupSupported(): AutoBackupStorage {
    if (!this.autoBackupStorage) {
      throw notImplemented('Cloudflare 部署模式不支持本地磁盘自动备份，请使用手动导出或 D1 Time Travel');
    }
    return this.autoBackupStorage;
  }

  validate(value: unknown): NormalizedBackup {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ValidationError('全量备份格式、版本或字段无效');
    }

    const parsed = backupV2Schema.safeParse(value);
    if (!parsed.success) throw new ValidationError('全量备份格式、版本或字段无效');
    const d = parsed.data;
    const normalized: NormalizedBackup = {
      sourceVersion: 2,
      exportedAt: d.exportedAt,
      settings: d.settings,
      proxies: d.proxies ?? [],
      reminders: d.reminders,
      channels: d.channels,
      reminderChannels: d.reminderChannels,
      deliveries: d.deliveries ?? [],
      receipts: d.receipts ?? [],
    };

    if (utf8ByteLength(JSON.stringify(value)) > MAX_BACKUP_BYTES) {
      throw payloadTooLarge('备份超过 32 MB，请使用数据库导出备份恢复');
    }

    assertUnique(normalized.settings.map((r) => r.key), '设置');
    const globalTimezone = normalized.settings.find((r) => r.key === 'global_timezone')?.value;
    if (!globalTimezone || !isValidTimezone(globalTimezone)) {
      throw new ValidationError('备份全局时区无效');
    }

    const proxyIds = assertUnique(normalized.proxies.map((r) => r.id), '代理 ID');
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

    for (const ch of normalized.channels) {
      if (ch.proxy_id && !proxyIds.has(ch.proxy_id)) {
        throw new ValidationError('备份渠道引用了不存在的代理');
      }
    }

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
      if (!linked.some((cid) => usableChannelIds.has(cid))) {
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

  async export(): Promise<FullBackupExport> {
    const [rawSettings, proxies, reminders, channels, reminderChannels] = await this.db.batchQuery<Record<string, unknown>>([
      { sql: 'SELECT key, value, updated_at FROM settings' },
      { sql: 'SELECT id, name, protocol, host, port, username, password, enabled, created_at, updated_at FROM proxies' },
      { sql: 'SELECT * FROM reminders WHERE deleted_at IS NULL' },
      { sql: 'SELECT id, name, type, enabled, config, proxy_id, created_at, updated_at FROM channels' },
      {
        sql: `SELECT rc.reminder_id, rc.channel_id
              FROM reminder_channels rc
              INNER JOIN reminders r ON r.id = rc.reminder_id
              WHERE r.deleted_at IS NULL`,
      },
    ]);

    const settings = ((rawSettings ?? []) as Array<z.infer<typeof settingSchema>>).filter(
      (row) => !INTERNAL_SETTING_KEYS.has(row.key),
    );

    const snapshot: FullBackupExport = {
      format: 'tickbell-full-backup',
      version: 2,
      exportedAt: new Date().toISOString(),
      settings,
      proxies: (proxies ?? []) as Array<z.infer<typeof proxySchema>>,
      reminders: (reminders ?? []) as Array<z.infer<typeof reminderSchema>>,
      channels: (channels ?? []) as Array<z.infer<typeof channelV2Schema>>,
      reminderChannels: (reminderChannels ?? []) as Array<z.infer<typeof reminderChannelSchema>>,
    };

    this.validate(snapshot);
    return snapshot;
  }

  /**
   * Atomically restores a full backup in a single `db.batch()`, safely chunking multi-row INSERTs
   * by column count so every statement stays <= `db.maxBindParams` (D1 limit: 100).
   */
  async restore(rawBackup: unknown): Promise<void> {
    const backup = this.validate(rawBackup);

    this.restoring = true;
    await this.schedulerHooks?.pause();
    try {
      const now = Date.now();
      const preserved = await this.settingsRepo.getMany([
        SETTING_AUTH_PASSWORD_HASH,
        SETTING_AUTH_SESSION_SECRET,
        SETTING_AUTO_BACKUP_CONFIG,
        SETTING_AUTO_BACKUP_STATE,
        SETTING_CRON_HEARTBEAT,
        SETTING_LAST_CLEANUP_AT,
      ]);

      const stmts: SqlStatement[] = [
        { sql: 'DELETE FROM deliveries' },
        { sql: 'DELETE FROM reminder_channels' },
        { sql: 'DELETE FROM reminders' },
        { sql: 'DELETE FROM channels' },
        { sql: 'DELETE FROM proxies' },
        { sql: 'DELETE FROM settings' },
      ];

      // Settings (user settings + preserved internal settings + rotated session generation)
      const settingRows: Array<[string, string, number]> = [];
      for (const s of backup.settings) {
        if (INTERNAL_SETTING_KEYS.has(s.key)) continue;
        settingRows.push([s.key, s.value, s.updated_at]);
      }
      for (const [key, val] of preserved.entries()) {
        if (val) settingRows.push([key, val, now]);
      }
      settingRows.push([SETTING_SESSION_GENERATION, randomUuid(), now]);

      stmts.push(
        ...buildMultiRowInsertStatements(
          'settings',
          ['key', 'value', 'updated_at'],
          settingRows,
          this.db.maxBindParams,
        ),
      );

      // Proxies (10 cols -> max 9 rows/stmt on D1)
      stmts.push(
        ...buildMultiRowInsertStatements(
          'proxies',
          ['id', 'name', 'protocol', 'host', 'port', 'username', 'password', 'enabled', 'created_at', 'updated_at'],
          backup.proxies.map((p) => [
            p.id,
            p.name,
            p.protocol,
            p.host,
            p.port,
            p.username,
            p.password,
            p.enabled,
            p.created_at,
            p.updated_at,
          ]),
          this.db.maxBindParams,
        ),
      );

      // Channels (8 cols -> max 11 rows/stmt on D1)
      stmts.push(
        ...buildMultiRowInsertStatements(
          'channels',
          ['id', 'name', 'type', 'enabled', 'config', 'proxy_id', 'created_at', 'updated_at'],
          backup.channels.map((ch) => [
            ch.id,
            ch.name,
            ch.type,
            this.registry.has(ch.type) ? ch.enabled : 0,
            ch.config,
            ch.proxy_id ?? null,
            ch.created_at,
            ch.updated_at,
          ]),
          this.db.maxBindParams,
        ),
      );

      // Reminders (18 cols -> max 5 rows/stmt on D1; all restored paused for safety)
      stmts.push(
        ...buildMultiRowInsertStatements(
          'reminders',
          [
            'id',
            'title',
            'content',
            'content_html',
            'category',
            'tags',
            'timezone',
            'starts_at',
            'is_repeating',
            'repeat_every',
            'repeat_unit',
            'enabled',
            'completed',
            'next_run_at',
            'schedule_version',
            'deleted_at',
            'created_at',
            'updated_at',
          ],
          backup.reminders.map((r) => [
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
            0,
            r.completed,
            r.next_run_at,
            r.schedule_version,
            r.deleted_at,
            r.created_at,
            r.updated_at,
          ]),
          this.db.maxBindParams,
        ),
      );

      // Reminder-channel links (2 cols -> max 45 rows/stmt on D1)
      stmts.push(
        ...buildMultiRowInsertStatements(
          'reminder_channels',
          ['reminder_id', 'channel_id'],
          backup.reminderChannels.map((link) => [link.reminder_id, link.channel_id]),
          this.db.maxBindParams,
        ),
      );

      // Deliveries (14 cols -> max 6 rows/stmt on D1)
      const receiptRows: Array<[string, number, string]> = [];
      stmts.push(
        ...buildMultiRowInsertStatements(
          'deliveries',
          [
            'id',
            'event_id',
            'reminder_id',
            'scheduled_at',
            'channel_id',
            'status',
            'attempts',
            'next_retry_at',
            'http_status',
            'error',
            'response_summary',
            'sent_at',
            'created_at',
            'updated_at',
          ],
          backup.deliveries.map((d) => {
            const ambiguous = d.status === 'pending' || d.status === 'retrying';
            receiptRows.push([d.reminder_id, d.scheduled_at, d.channel_id]);
            return [
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
            ];
          }),
          this.db.maxBindParams,
        ),
      );

      for (const receipt of backup.receipts) {
        receiptRows.push([receipt.reminder_id, receipt.scheduled_at, receipt.channel_id]);
      }

      // Merge delivery receipts (3 cols -> max 30 rows/stmt on D1)
      stmts.push(
        ...buildMultiRowInsertStatements(
          'delivery_receipts',
          ['reminder_id', 'scheduled_at', 'channel_id'],
          receiptRows,
          this.db.maxBindParams,
          'INSERT OR IGNORE INTO',
        ),
      );

      await this.db.batch(stmts);
    } finally {
      this.restoring = false;
      this.schedulerHooks?.resume();
    }
  }

  // ---------- Optional Local Disk Auto-Backup (Node / Docker mode) ----------

  private async loadAutoBackupConfig(): Promise<AutoBackupConfig> {
    const raw = await this.settings.getSetting(SETTING_AUTO_BACKUP_CONFIG);
    if (!raw) return { ...DEFAULT_AUTO_BACKUP_CONFIG };
    try {
      const parsed = JSON.parse(raw) as Partial<AutoBackupConfig>;
      return {
        enabled: parsed.enabled === true,
        time: typeof parsed.time === 'string' && TIME_HHMM_RE.test(parsed.time) ? parsed.time : DEFAULT_AUTO_BACKUP_CONFIG.time,
        intervalEvery:
          typeof parsed.intervalEvery === 'number' && Number.isInteger(parsed.intervalEvery) && parsed.intervalEvery >= 1
            ? parsed.intervalEvery
            : DEFAULT_AUTO_BACKUP_CONFIG.intervalEvery,
        intervalUnit:
          parsed.intervalUnit && (AUTO_BACKUP_INTERVAL_UNITS as readonly string[]).includes(parsed.intervalUnit)
            ? parsed.intervalUnit
            : DEFAULT_AUTO_BACKUP_CONFIG.intervalUnit,
        maxFiles:
          typeof parsed.maxFiles === 'number' && Number.isInteger(parsed.maxFiles) && parsed.maxFiles >= 1
            ? parsed.maxFiles
            : DEFAULT_AUTO_BACKUP_CONFIG.maxFiles,
      };
    } catch {
      return { ...DEFAULT_AUTO_BACKUP_CONFIG };
    }
  }

  private async loadAutoBackupState(): Promise<AutoBackupStateInternal> {
    const raw = await this.settings.getSetting(SETTING_AUTO_BACKUP_STATE);
    if (!raw) return { lastRunAt: null, lastFile: null, nextRunAt: null, lastError: null, timezone: null };
    try {
      const parsed = JSON.parse(raw) as Partial<AutoBackupStateInternal>;
      return {
        lastRunAt: typeof parsed.lastRunAt === 'number' ? parsed.lastRunAt : null,
        lastFile: typeof parsed.lastFile === 'string' ? parsed.lastFile : null,
        nextRunAt: typeof parsed.nextRunAt === 'number' ? parsed.nextRunAt : null,
        lastError: typeof parsed.lastError === 'string' ? parsed.lastError : null,
        timezone: typeof parsed.timezone === 'string' ? parsed.timezone : null,
      };
    } catch {
      return { lastRunAt: null, lastFile: null, nextRunAt: null, lastError: null, timezone: null };
    }
  }

  private async saveAutoBackupState(state: AutoBackupStateInternal, now = Date.now()): Promise<void> {
    await this.settings.setSetting(SETTING_AUTO_BACKUP_STATE, JSON.stringify(state), now);
  }

  private computeNextAutoBackupAt(
    cfg: AutoBackupConfig,
    tz: string,
    now: number,
    previousScheduledAt?: number | null,
  ): number {
    const [hourStr, minStr] = cfg.time.split(':');
    const nowZdt = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(tz);
    const todayAnchor = nowZdt
      .toPlainDate()
      .toPlainDateTime({ hour: Number(hourStr), minute: Number(minStr) })
      .toZonedDateTime(tz, { disambiguation: 'compatible' })
      .toInstant().epochMilliseconds;

    if (previousScheduledAt !== undefined && previousScheduledAt !== null) {
      return calculateNextFutureRun(previousScheduledAt, now, {
        every: cfg.intervalEvery,
        unit: cfg.intervalUnit,
        timezone: tz,
        startsAt: todayAnchor,
      });
    }
    return calculateNextFutureRun(todayAnchor, now, {
      every: cfg.intervalEvery,
      unit: cfg.intervalUnit,
      timezone: tz,
      startsAt: todayAnchor,
    });
  }

  private async ensureAutoBackupStateTimezone(
    cfg: AutoBackupConfig,
    state: AutoBackupStateInternal,
    tz: string,
    now: number,
  ): Promise<{ state: AutoBackupStateInternal; rescheduled: boolean }> {
    if (!cfg.enabled) return { state, rescheduled: false };
    if (state.nextRunAt !== null && state.timezone === tz) return { state, rescheduled: false };
    const nextState: AutoBackupStateInternal = {
      ...state,
      nextRunAt: this.computeNextAutoBackupAt(cfg, tz, now),
      timezone: tz,
    };
    await this.saveAutoBackupState(nextState, now);
    return { state: nextState, rescheduled: true };
  }

  private formatAutoBackupFileName(now: number, tz: string): string {
    const zdt = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(tz);
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${zdt.year}${pad(zdt.month)}${pad(zdt.day)}-${pad(zdt.hour)}${pad(zdt.minute)}${pad(zdt.second)}`;
    return `tickbell-auto-${stamp}.json`;
  }

  private assertValidAutoBackupFileName(name: string): string {
    if (!AUTO_BACKUP_FILE_RE.test(name)) {
      throw new ValidationError('备份文件名无效');
    }
    return name;
  }

  async getAutoBackupView(now = Date.now()): Promise<AutoBackupView> {
    const storage = this.assertAutoBackupSupported();
    const [cfg, tz, rawState, files] = await Promise.all([
      this.loadAutoBackupConfig(),
      this.settings.getGlobalTimezone(),
      this.loadAutoBackupState(),
      storage.listFiles(),
    ]);
    const { state } = await this.ensureAutoBackupStateTimezone(cfg, rawState, tz, now);
    return {
      config: cfg,
      state: {
        lastRunAt: state.lastRunAt ? epochToIso(state.lastRunAt) : null,
        lastFile: state.lastFile,
        nextRunAt: cfg.enabled && state.nextRunAt ? epochToIso(state.nextRunAt) : null,
        lastError: state.lastError,
      },
      timezone: tz,
      backupDir: storage.backupDir,
      files,
    };
  }

  async updateAutoBackupConfig(raw: unknown, now = Date.now()): Promise<AutoBackupView> {
    const storage = this.assertAutoBackupSupported();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ValidationError('自动备份配置必须是 JSON 对象');
    }
    const body = raw as Record<string, unknown>;
    const enabled = body.enabled === true;
    const time = typeof body.time === 'string' ? body.time.trim() : '';
    const intervalEvery = typeof body.intervalEvery === 'number' ? body.intervalEvery : Number(body.intervalEvery);
    const intervalUnit = typeof body.intervalUnit === 'string' ? body.intervalUnit.trim() : '';
    const maxFiles = typeof body.maxFiles === 'number' ? body.maxFiles : Number(body.maxFiles);

    if (!TIME_HHMM_RE.test(time)) {
      throw new ValidationError('备份时间格式无效，请填写 HH:mm（例如 03:00）');
    }
    if (!(AUTO_BACKUP_INTERVAL_UNITS as readonly string[]).includes(intervalUnit)) {
      throw new ValidationError('循环单位仅支持天或小时');
    }
    const unit = intervalUnit as AutoBackupIntervalUnit;
    const maxInterval = unit === 'hour' ? 720 : 365;
    if (!Number.isInteger(intervalEvery) || intervalEvery < 1 || intervalEvery > maxInterval) {
      throw new ValidationError(`循环间隔必须为 1 到 ${maxInterval} 的整数`);
    }
    if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 100) {
      throw new ValidationError('最多保留份数必须为 1 到 100 的整数');
    }

    const nextCfg: AutoBackupConfig = { enabled, time, intervalEvery, intervalUnit: unit, maxFiles };
    const [tz, prevState] = await Promise.all([this.settings.getGlobalTimezone(), this.loadAutoBackupState()]);
    const nextState: AutoBackupStateInternal = {
      ...prevState,
      nextRunAt: enabled ? this.computeNextAutoBackupAt(nextCfg, tz, now) : null,
      lastError: null,
      timezone: tz,
    };

    await this.db.batch([
      this.settingsRepo.upsertStatement(SETTING_AUTO_BACKUP_CONFIG, JSON.stringify(nextCfg), now),
      this.settingsRepo.upsertStatement(SETTING_AUTO_BACKUP_STATE, JSON.stringify(nextState), now),
    ]);
    await storage.pruneFiles(nextCfg.maxFiles);
    return this.getAutoBackupView(now);
  }

  async runAutoBackupNow(
    now = Date.now(),
    advanceScheduleFrom?: number | null,
  ): Promise<{ file: AutoBackupFileInfo; view: AutoBackupView }> {
    const storage = this.assertAutoBackupSupported();
    const [cfg, tz, payload, prevState] = await Promise.all([
      this.loadAutoBackupConfig(),
      this.settings.getGlobalTimezone(),
      this.export(),
      this.loadAutoBackupState(),
    ]);

    const fileName = this.formatAutoBackupFileName(now, tz);
    const file = await storage.writeFile(fileName, JSON.stringify(payload, null, 2), now);
    await storage.pruneFiles(cfg.maxFiles);

    let nextRunAt: number | null = null;
    if (cfg.enabled) {
      if (advanceScheduleFrom !== undefined && advanceScheduleFrom !== null) {
        nextRunAt = this.computeNextAutoBackupAt(cfg, tz, now, advanceScheduleFrom);
      } else if (prevState.timezone === tz && prevState.nextRunAt !== null && prevState.nextRunAt > now) {
        nextRunAt = prevState.nextRunAt;
      } else {
        nextRunAt = this.computeNextAutoBackupAt(cfg, tz, now);
      }
    }

    await this.saveAutoBackupState(
      {
        lastRunAt: now,
        lastFile: fileName,
        nextRunAt,
        lastError: null,
        timezone: tz,
      },
      now,
    );

    return {
      file,
      view: await this.getAutoBackupView(now),
    };
  }

  async runAutoBackupIfDue(now = Date.now()): Promise<boolean> {
    if (!this.autoBackupStorage || this.autoBackupRunning || this.restoring) return false;
    const cfg = await this.loadAutoBackupConfig();
    if (!cfg.enabled) return false;

    const tz = await this.settings.getGlobalTimezone();
    const { state, rescheduled } = await this.ensureAutoBackupStateTimezone(
      cfg,
      await this.loadAutoBackupState(),
      tz,
      now,
    );
    if (rescheduled || state.nextRunAt === null || state.nextRunAt > now) return false;

    this.autoBackupRunning = true;
    try {
      const { file } = await this.runAutoBackupNow(now, state.nextRunAt);
      this.logger.info({ file: file.name, sizeBytes: file.sizeBytes }, 'Completed scheduled JSON auto-backup');
      return true;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger.error({ err: errMsg }, 'Scheduled JSON auto-backup failed');
      await this.saveAutoBackupState(
        {
          ...state,
          nextRunAt: this.computeNextAutoBackupAt(cfg, tz, now, state.nextRunAt),
          lastError: errMsg.slice(0, 300),
          timezone: tz,
        },
        now,
      );
      return false;
    } finally {
      this.autoBackupRunning = false;
    }
  }

  async readAutoBackupFile(name: string): Promise<{ name: string; backup: unknown }> {
    const storage = this.assertAutoBackupSupported();
    const safeName = this.assertValidAutoBackupFileName(name);
    const content = await storage.readFile(safeName, MAX_BACKUP_BYTES);
    if (content === null) {
      throw notFound('备份文件不存在');
    }
    try {
      return { name: safeName, backup: JSON.parse(content) };
    } catch {
      throw new ValidationError('备份文件已损坏，无法解析为 JSON');
    }
  }

  async deleteAutoBackupFile(name: string): Promise<AutoBackupFileInfo[]> {
    const storage = this.assertAutoBackupSupported();
    const safeName = this.assertValidAutoBackupFileName(name);
    const deleted = await storage.deleteFile(safeName);
    if (!deleted) {
      throw notFound('备份文件不存在');
    }
    return storage.listFiles();
  }
}
