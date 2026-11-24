import type { z } from 'zod';
import type { ProxyTarget } from '../ports/index';
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

export interface NotificationSendOptions {
  proxy?: ProxyTarget | null;
}

export interface ChannelProvider<TConfig extends Record<string, unknown> = Record<string, unknown>> {
  readonly type: string;
  readonly meta: ChannelMeta;
  readonly fields: readonly ChannelField[];
  readonly configSchema: z.ZodType<TConfig>;

  mergeConfig(
    input: unknown,
    existing: TConfig | null,
    enabled: boolean,
    policy: PrivateNetworkPolicy,
  ): TConfig | null;

  maskConfig(config: TConfig | null): MaskedChannelConfig;

  isConfigured(config: TConfig | null): boolean;

  send(
    message: NotificationMessage,
    config: TConfig,
    options?: NotificationSendOptions,
  ): Promise<NotificationResult>;
}
