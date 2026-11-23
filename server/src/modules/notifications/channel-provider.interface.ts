import type { z } from 'zod';
import type { PrivateNetworkPolicy } from './http/url-policy';

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
  /** Optional section heading used by the frontend generic form to group fields visually. */
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

export interface ChannelMeta {
  type: string;
  name: string;
  description: string;
  icon: string;
  order?: number;
}

export interface ChannelTypeDescriptor {
  type: string;
  name: string;
  description: string;
  icon: string;
  fields: ChannelField[];
}

export interface NotificationMessage {
  eventId: string;
  reminderId: string;
  title: string;
  content: string;
  contentHtml?: string | null;
  timezone: string;
  scheduledAt: number;
  triggeredAt: number;
  isLate?: boolean;
  isTest?: boolean;
}

/**
 * Error classification consumed by the scheduler/retry layer:
 * - `retryable`: definitely not delivered or explicitly rate-limited by platform
 * - `permanent`: configuration/auth/signature/client error — do not auto-retry
 * - `unknown`: ambiguous outcome (read timeout, HTTP 500) — do not auto-retry to avoid duplicates
 */
export type NotificationErrorClass = 'retryable' | 'permanent' | 'unknown';

export interface NotificationResult {
  ok: boolean;
  httpStatus: number | null;
  responseSummary: string;
  error: string | null;
  errorClass?: NotificationErrorClass;
}

export interface ChannelSummaryItem {
  label: string;
  value: string;
}

export interface MaskedChannelConfig {
  config: Record<string, unknown> | null;
  secretsSet: string[];
  configured: boolean;
  summary: ChannelSummaryItem[];
}

export interface ChannelProvider<TConfig extends Record<string, unknown> = Record<string, unknown>> {
  readonly type: string;
  readonly meta: ChannelMeta;
  readonly fields: readonly ChannelField[];
  readonly configSchema: z.ZodType<TConfig>;

  /** Validates & merges incoming config with existing config. */
  mergeConfig(
    input: unknown,
    existing: TConfig | null,
    enabled: boolean,
    policy: PrivateNetworkPolicy,
  ): TConfig | null;

  /** Returns public config view, secret status, configured flag, and concise card summary items. */
  maskConfig(config: TConfig | null): MaskedChannelConfig;

  /** Returns true if config has everything required to send a notification. */
  isConfigured(config: TConfig | null): boolean;

  /** Sends a notification via this provider. */
  send(message: NotificationMessage, config: TConfig): Promise<NotificationResult>;
}

/** Multi-provider DI token. Register new channel providers here. */
export const CHANNEL_PROVIDERS = Symbol('CHANNEL_PROVIDERS');

/** Shared HTTP transport token injected into all providers (overridable in unit/e2e tests). */
export const NOTIFICATION_HTTP_POST = Symbol('NOTIFICATION_HTTP_POST');
