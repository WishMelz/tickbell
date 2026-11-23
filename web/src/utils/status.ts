import type { DeliveryStatus, ReminderView } from '@/api/types';

export type ChipTone = 'positive' | 'negative' | 'warning' | 'info' | 'primary' | 'grey';

export interface StatusMeta {
  label: string;
  tone: ChipTone;
}

export function reminderStatus(reminder: Pick<ReminderView, 'enabled' | 'completed'>): StatusMeta {
  if (reminder.completed) return { label: '已完成', tone: 'grey' };
  return reminder.enabled ? { label: '运行中', tone: 'positive' } : { label: '已暂停', tone: 'warning' };
}

export const DELIVERY_STATUS: Record<DeliveryStatus, StatusMeta> = {
  pending: { label: '发送中', tone: 'info' },
  sent: { label: '已发送', tone: 'positive' },
  failed: { label: '失败', tone: 'negative' },
  retrying: { label: '等待重试', tone: 'warning' },
  skipped: { label: '已跳过', tone: 'grey' },
};

export const DELIVERY_STATUS_OPTIONS: Array<{ label: string; value: DeliveryStatus | '' }> = [
  { label: '全部状态', value: '' },
  { label: '已发送', value: 'sent' },
  { label: '失败', value: 'failed' },
  { label: '等待重试', value: 'retrying' },
  { label: '已跳过', value: 'skipped' },
  { label: '发送中', value: 'pending' },
];

export function chipClass(tone: ChipTone): string {
  return `soft-chip soft-chip--${tone}`;
}
