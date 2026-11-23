/**
 * 与 docs/API.md 一一对应的类型定义。改接口时先改 API.md，再改这里。
 */

// ---------- Auth ----------
export type ConfigurationIssue = 'missing' | 'too_short' | null;

export interface AuthStatus {
  initialized: boolean;
  configured: boolean;
  authenticated: boolean;
  configurationIssue: ConfigurationIssue;
}

// ---------- Settings ----------
export interface Settings {
  globalTimezone: string;
}

// ---------- Channels ----------
export type ChannelFieldControl = 'text' | 'password' | 'url' | 'select' | 'switch' | 'number' | 'textarea';

export interface ChannelFieldOption {
  label: string;
  value: string | number | boolean;
}

export interface ChannelFieldShowWhen {
  field: string;
  in?: unknown[];
  notIn?: unknown[];
}

export interface ChannelField {
  key: string;
  label: string;
  group?: string;
  control: ChannelFieldControl;
  required: boolean;
  secret: boolean;
  default?: unknown;
  options?: ChannelFieldOption[];
  min?: number;
  max?: number;
  help?: string;
  placeholder?: string;
  showWhen?: ChannelFieldShowWhen;
}

export interface ChannelType {
  type: string;
  name: string;
  description: string;
  icon: string;
  fields: ChannelField[];
}

export interface ChannelSummaryItem {
  label: string;
  value: string;
}

export interface ChannelView {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  supported: boolean;
  config: Record<string, unknown> | null;
  secretsSet: string[];
  configured: boolean;
  summary?: ChannelSummaryItem[];
  createdAt: string;
  updatedAt: string;
}

export interface ChannelCreateInput {
  name: string;
  type: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface ChannelUpdateInput {
  name: string;
  enabled: boolean;
  /** 省略表示不改配置（只改名 / 启停，supported=false 的渠道只能这样改） */
  config?: Record<string, unknown>;
}

export interface ChannelTestResult {
  ok: boolean;
  httpStatus: number | null;
  responseSummary: string | null;
  error: string | null;
}

// ---------- Reminders ----------
export type RepeatUnit = 'minute' | 'hour' | 'day' | 'month' | 'year';
export type ReminderStatusFilter = 'active' | 'paused' | 'completed';

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

export interface ReminderInput {
  title: string;
  content?: string;
  contentHtml?: string | null;
  category?: string;
  tags?: string[];
  scheduledLocal: string;
  timezone: string | null;
  isRepeating: boolean;
  repeatEvery: number | null;
  repeatUnit: RepeatUnit | null;
  channelIds: string[];
  enabled?: boolean;
}

export interface ReminderFilters {
  search?: string;
  category?: string;
  tag?: string;
  status?: ReminderStatusFilter | '';
}

export type ReminderBatchAction = 'enable' | 'disable' | 'delete' | 'channels';

export interface ReminderBatchInput {
  ids: string[];
  action: ReminderBatchAction;
  channelIds?: string[];
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

// ---------- Deliveries ----------
export type DeliveryStatus = 'pending' | 'sent' | 'failed' | 'retrying' | 'skipped';

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

export interface DeliveryFilters {
  reminderId?: string;
  channelId?: string;
  status?: DeliveryStatus | '';
  page: number;
  pageSize: number;
}

export interface DeliveryPage {
  items: DeliveryView[];
  total: number;
  page: number;
  pageSize: number;
}

// ---------- System ----------
export interface HealthStatus {
  status: 'ok' | 'degraded';
  db: string;
  scheduler: { enabled: boolean; lastTickAt: string | null; healthy: boolean };
}

export interface SystemStatus {
  version: string;
  startedAt: string;
  uptimeSeconds: number;
  nodeVersion: string;
  scheduler: {
    enabled: boolean;
    paused: boolean;
    intervalMs: number;
    lastTickAt: string | null;
    lastTickDurationMs: number | null;
  };
  counts: { reminders: number; activeReminders: number; channels: number; retryingDeliveries: number };
  limits: { maxReminders: number; missedGraceMinutes: number; deliveryRetentionDays: number };
  backup: { lastBackupAt: string | null; lastBackupFile: string | null; keepDays: number };
}

// ---------- Backup ----------
export interface BackupPreview {
  reminders: number;
  activeReminders: number;
  deletedReminders: number;
  channels: number;
  /** API.md 未注明类型：按数量处理；如果后端返回渠道列表，界面也能展示 */
  unsupportedChannels: number | Array<{ id?: string; name: string; type: string }>;
  deliveries: number;
  pendingDeliveries: number;
  globalTimezone: string;
  exportedAt: string;
  sourceVersion: 1 | 2;
  remindersWithoutUsableChannel: { id: string; title: string }[];
}
