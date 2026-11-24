import { request } from './http';
import type {
  AuthStatus,
  AutoBackupConfig,
  AutoBackupFileInfo,
  AutoBackupView,
  BackupPreview,
  ChannelCreateInput,
  ChannelTestResult,
  ChannelType,
  ChannelUpdateInput,
  ChannelView,
  DeliveryFilters,
  DeliveryPage,
  DeliveryView,
  HealthStatus,
  ProxyInput,
  ProxyTestInput,
  ProxyTestResult,
  ProxyView,
  ReminderBatchInput,
  ReminderBatchResult,
  ReminderFilters,
  ReminderInput,
  ReminderTestResult,
  ReminderView,
  Settings,
  SystemStatus,
} from './types';

export * from './types';
export { ApiError, errorMessage, isApiError, onUnauthorized } from './http';

const enc = encodeURIComponent;

export const api = {
  // Auth
  authStatus: () => request<AuthStatus>('/auth/status'),
  setupAuth: (input: { password: string; secret: string; globalTimezone?: string }) =>
    request<{ authenticated: boolean }>('/auth/setup', { method: 'POST', body: input }),
  login: (password: string) => request<{ authenticated: boolean }>('/auth/login', { method: 'POST', body: { password } }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ changed: boolean }>('/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } }),
  logout: () => request<null>('/auth/logout', { method: 'POST' }),

  // Settings
  getSettings: () => request<Settings>('/settings'),
  updateSettings: (globalTimezone: string) => request<Settings>('/settings', { method: 'PUT', body: { globalTimezone } }),

  // Proxies
  listProxies: () => request<ProxyView[]>('/proxies'),
  createProxy: (input: ProxyInput) => request<ProxyView>('/proxies', { method: 'POST', body: input }),
  updateProxy: (id: string, input: ProxyInput) => request<ProxyView>(`/proxies/${enc(id)}`, { method: 'PUT', body: input }),
  deleteProxy: (id: string) => request<{ deleted: true; detachedChannels: number }>(`/proxies/${enc(id)}`, { method: 'DELETE' }),
  testProxy: (id: string, testUrl?: string) =>
    request<ProxyTestResult>(`/proxies/${enc(id)}/test`, { method: 'POST', body: testUrl ? { testUrl } : {} }),
  testAdhocProxy: (input: ProxyTestInput) => request<ProxyTestResult>('/proxies/test', { method: 'POST', body: input }),

  // Channels
  channelTypes: () => request<ChannelType[]>('/channels/types'),
  listChannels: () => request<ChannelView[]>('/channels'),
  createChannel: (input: ChannelCreateInput) => request<ChannelView>('/channels', { method: 'POST', body: input }),
  updateChannel: (id: string, input: ChannelUpdateInput) => request<ChannelView>(`/channels/${enc(id)}`, { method: 'PUT', body: input }),
  deleteChannel: (id: string) => request<null>(`/channels/${enc(id)}`, { method: 'DELETE' }),
  testChannel: (id: string) => request<ChannelTestResult>(`/channels/${enc(id)}/test`, { method: 'POST' }),

  // Reminders
  listReminders: (filters: ReminderFilters = {}, signal?: AbortSignal) =>
    request<ReminderView[]>('/reminders', {
      query: { search: filters.search?.trim(), category: filters.category, tag: filters.tag, status: filters.status },
      signal,
    }),
  getReminder: (id: string) => request<ReminderView>(`/reminders/${enc(id)}`),
  createReminder: (input: ReminderInput) => request<ReminderView>('/reminders', { method: 'POST', body: input }),
  updateReminder: (id: string, input: ReminderInput) => request<ReminderView>(`/reminders/${enc(id)}`, { method: 'PUT', body: input }),
  deleteReminder: (id: string) => request<null>(`/reminders/${enc(id)}`, { method: 'DELETE' }),
  enableReminder: (id: string) => request<ReminderView>(`/reminders/${enc(id)}/enable`, { method: 'POST' }),
  disableReminder: (id: string) => request<ReminderView>(`/reminders/${enc(id)}/disable`, { method: 'POST' }),
  batchReminders: (input: ReminderBatchInput) => request<ReminderBatchResult>('/reminders/batch', { method: 'POST', body: input }),
  testReminder: (input: ReminderInput) => request<ReminderTestResult[]>('/reminders/test', { method: 'POST', body: input }),

  // Deliveries
  listDeliveries: (filters: DeliveryFilters, signal?: AbortSignal) =>
    request<DeliveryPage>('/deliveries', {
      query: {
        reminderId: filters.reminderId,
        channelId: filters.channelId,
        status: filters.status,
        page: filters.page,
        pageSize: filters.pageSize,
      },
      signal,
    }),
  retryDelivery: (id: string) => request<DeliveryView>(`/deliveries/${enc(id)}/retry`, { method: 'POST' }),

  // System
  health: () => request<HealthStatus>('/health'),
  systemStatus: () => request<SystemStatus>('/system/status'),

  // Backup（明文 JSON；加解密在浏览器端完成，见 utils/fullBackup.ts）
  exportBackup: (password: string) => request<unknown>('/backup/export', { method: 'POST', body: { password } }),
  previewBackup: (backup: unknown) => request<BackupPreview>('/backup/preview', { method: 'POST', body: { backup } }),
  restoreBackup: (backup: unknown, password: string, confirmation: string) =>
    request<{ restored: boolean }>('/backup/restore', { method: 'POST', body: { backup, password, confirmation } }),
  getAutoBackup: () => request<AutoBackupView>('/backup/auto'),
  updateAutoBackup: (config: AutoBackupConfig) =>
    request<AutoBackupView>('/backup/auto', { method: 'PUT', body: config }),
  runAutoBackupNow: () => request<{ file: AutoBackupFileInfo; view: AutoBackupView }>('/backup/auto/run', { method: 'POST' }),
  readAutoBackupFile: (name: string) =>
    request<{ name: string; backup: unknown }>(`/backup/auto/files/${enc(name)}`),
  deleteAutoBackupFile: (name: string) =>
    request<AutoBackupFileInfo[]>(`/backup/auto/files/${enc(name)}`, { method: 'DELETE' }),
};
