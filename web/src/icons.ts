/**
 * 图标统一出口：Material Symbols Outlined 的 SVG 版本（@quasar/extras），按需打包。
 * 不使用图标字体：Material Symbols 的 woff2 约 4 MB，会严重拖慢 4G 首屏；SVG 只打包用到的图标，也不需要 CDN。
 * 用法：<q-icon :name="icons.add" /> 或 <q-btn :icon="icons.add" />
 */
import {
  symOutlinedAdd,
  symOutlinedAlarm,
  symOutlinedArrowDownward,
  symOutlinedArrowUpward,
  symOutlinedBackup,
  symOutlinedBlock,
  symOutlinedCampaign,
  symOutlinedCancel,
  symOutlinedCategory,
  symOutlinedChat,
  symOutlinedCheck,
  symOutlinedCheckCircle,
  symOutlinedChecklist,
  symOutlinedChevronLeft,
  symOutlinedClose,
  symOutlinedContentCopy,
  symOutlinedContrast,
  symOutlinedDarkMode,
  symOutlinedDelete,
  symOutlinedDns,
  symOutlinedDownload,
  symOutlinedEdit,
  symOutlinedError,
  symOutlinedEvent,
  symOutlinedFilterList,
  symOutlinedFormatBold,
  symOutlinedFormatClear,
  symOutlinedFormatItalic,
  symOutlinedFormatListBulleted,
  symOutlinedFormatListNumbered,
  symOutlinedFormatQuote,
  symOutlinedFormatStrikethrough,
  symOutlinedFormatUnderlined,
  symOutlinedHistory,
  symOutlinedHourglassEmpty,
  symOutlinedInfo,
  symOutlinedKey,
  symOutlinedLabel,
  symOutlinedLightMode,
  symOutlinedLink,
  symOutlinedLinkOff,
  symOutlinedLock,
  symOutlinedLogout,
  symOutlinedMail,
  symOutlinedMenu,
  symOutlinedMenuOpen,
  symOutlinedMonitorHeart,
  symOutlinedMoreVert,
  symOutlinedNotifications,
  symOutlinedNotificationsActive,
  symOutlinedNotificationsOff,
  symOutlinedPalette,
  symOutlinedPause,
  symOutlinedPending,
  symOutlinedPlayArrow,
  symOutlinedPublic,
  symOutlinedRedo,
  symOutlinedRefresh,
  symOutlinedRepeat,
  symOutlinedReplay,
  symOutlinedSchedule,
  symOutlinedSearch,
  symOutlinedSelectAll,
  symOutlinedSend,
  symOutlinedSettings,
  symOutlinedShare,
  symOutlinedSkipNext,
  symOutlinedSwapHoriz,
  symOutlinedUndo,
  symOutlinedUpload,
  symOutlinedVisibility,
  symOutlinedVisibilityOff,
  symOutlinedWarning,
  symOutlinedWebhook,
} from '@quasar/extras/material-symbols-outlined';

const svgGithub =
  'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12|0 0 24 24';

export const icons = {
  add: symOutlinedAdd,
  alarm: symOutlinedAlarm,
  arrowDown: symOutlinedArrowDownward,
  arrowUp: symOutlinedArrowUpward,
  backup: symOutlinedBackup,
  block: symOutlinedBlock,
  themeAuto: symOutlinedContrast,
  campaign: symOutlinedCampaign,
  cancel: symOutlinedCancel,
  category: symOutlinedCategory,
  check: symOutlinedCheck,
  checkCircle: symOutlinedCheckCircle,
  checklist: symOutlinedChecklist,
  back: symOutlinedChevronLeft,
  close: symOutlinedClose,
  copy: symOutlinedContentCopy,
  themeDark: symOutlinedDarkMode,
  delete: symOutlinedDelete,
  dns: symOutlinedDns,
  download: symOutlinedDownload,
  edit: symOutlinedEdit,
  error: symOutlinedError,
  event: symOutlinedEvent,
  filter: symOutlinedFilterList,
  bold: symOutlinedFormatBold,
  clearFormat: symOutlinedFormatClear,
  italic: symOutlinedFormatItalic,
  bulletList: symOutlinedFormatListBulleted,
  orderedList: symOutlinedFormatListNumbered,
  quote: symOutlinedFormatQuote,
  strike: symOutlinedFormatStrikethrough,
  underline: symOutlinedFormatUnderlined,
  github: svgGithub,
  history: symOutlinedHistory,
  hourglass: symOutlinedHourglassEmpty,
  info: symOutlinedInfo,
  key: symOutlinedKey,
  label: symOutlinedLabel,
  themeLight: symOutlinedLightMode,
  link: symOutlinedLink,
  unlink: symOutlinedLinkOff,
  lock: symOutlinedLock,
  logout: symOutlinedLogout,
  menu: symOutlinedMenu,
  menuOpen: symOutlinedMenuOpen,
  monitor: symOutlinedMonitorHeart,
  more: symOutlinedMoreVert,
  notifications: symOutlinedNotifications,
  notificationsActive: symOutlinedNotificationsActive,
  notificationsOff: symOutlinedNotificationsOff,
  palette: symOutlinedPalette,
  pause: symOutlinedPause,
  pending: symOutlinedPending,
  play: symOutlinedPlayArrow,
  globe: symOutlinedPublic,
  redo: symOutlinedRedo,
  refresh: symOutlinedRefresh,
  repeat: symOutlinedRepeat,
  retry: symOutlinedReplay,
  schedule: symOutlinedSchedule,
  search: symOutlinedSearch,
  selectAll: symOutlinedSelectAll,
  send: symOutlinedSend,
  settings: symOutlinedSettings,
  share: symOutlinedShare,
  skip: symOutlinedSkipNext,
  swap: symOutlinedSwapHoriz,
  undo: symOutlinedUndo,
  upload: symOutlinedUpload,
  visibility: symOutlinedVisibility,
  visibilityOff: symOutlinedVisibilityOff,
  warning: symOutlinedWarning,
} as const;

/** 7 种内置渠道的品牌 SVG 图标与配色 */
const svgTelegram =
  'M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z|0 0 24 24';

const svgBark =
  'M6.2 1H17.8Q23 1 23 6.2V17.8Q23 23 17.8 23H6.2Q1 23 1 17.8V6.2Q1 1 6.2 1ZM9 10.2V13.8H15V10.2ZM4.4 8.9V15.1Q4.4 15.9 5.1 15.7L7.6 15Q8.2 14.9 8.2 14.3V9.7Q8.2 9.1 7.6 9L5.1 8.3Q4.4 8.1 4.4 8.9ZM15.8 9.7V14.3Q15.8 14.9 16.4 15L18.9 15.7Q19.6 15.9 19.6 15.1V8.9Q19.6 8.1 18.9 8.3L16.4 9Q15.8 9.1 15.8 9.7ZM2.3 9.9Q1.9 10.1 2.1 10.5L3.7 13.8V9.3ZM20.3 10.2V14.7L21.7 14.1Q22.1 13.9 21.9 13.5Z|0 0 24 24';

const svgWeCom =
  'M9.2 3C4.67 3 1 6.08 1 9.88c0 2.16 1.2 4.08 3.07 5.34l-.77 2.34 2.7-1.35c.98.29 2.05.45 3.2.45.28 0 .56-.01.83-.04-.17-.55-.26-1.13-.26-1.73 0-3.54 3.35-6.41 7.49-6.41.29 0 .58.02.86.05C17.44 5.37 13.71 3 9.2 3zm-2.9 5.5a1.1 1.1 0 1 1 0-2.2 1.1 1.1 0 0 1 0 2.2zm5.8 0a1.1 1.1 0 1 1 0-2.2 1.1 1.1 0 0 1 0 2.2zm5.16 1.5c-3.44 0-6.24 2.33-6.24 5.2 0 2.87 2.8 5.2 6.24 5.2.72 0 1.41-.11 2.06-.3l2.03 1.02-.57-1.74c1.38-.95 2.22-2.46 2.22-4.18 0-2.87-2.8-5.2-6.24-5.2zm-2.06 4.4a.9.9 0 1 1 0-1.8.9.9 0 0 1 0 1.8zm4.12 0a.9.9 0 1 1 0-1.8.9.9 0 0 1 0 1.8z|0 0 24 24';

const svgDingTalk =
  'M12 1.5C6.2 1.5 1.5 6.2 1.5 12S6.2 22.5 12 22.5 22.5 17.8 22.5 12 17.8 1.5 12 1.5zm4.82 9.45l-2.02 2.48 1.38.1-4.88 5.42 1.02-3.95-1.72-.14 1.35-3.05c-1.95-.52-3.42-1.82-4.15-3.48 1.85.94 4.1 1.38 6.45 1.18-1.4-.92-2.48-2.16-3.02-3.66 2.22 1.24 4.86 1.82 7.5 1.56-.4 1.26-1.08 2.48-1.91 3.54z|0 0 24 24';

const svgFeishu =
  'M4.2 5.4c4.1 1.1 7.9 3.6 10.6 7.1 1.8-1.9 3.6-4.1 5-6.6.4-.7-.3-1.5-1-1.2-3.5 1.4-7.1 2.1-10.7 1.8-1.3-.1-2.6-.5-3.7-1.1-.6-.3-1 .3-.2 0zm-.9 3.8c3.6 2.2 6.8 5.4 9 9.2.6 1 2 .9 2.5-.1 1.4-2.8 3.1-5.6 5.4-7.8-3.4 1.3-6.7 1.5-9.8.6-2.4-.7-4.8-2.1-6.9-3.9-.6-.5-1.2.4-.2 2zm3.2 8.7c1.6 1.3 3.4 2.4 5.3 3.1.9.3 1.7-.6 1.2-1.4-1.5-2.3-3.5-4.4-5.9-6-.7-.5-1.4.4-1 1.1.4.8.7 1.6.4 3.2z|0 0 24 24';

const svgServerChan =
  'M12 2C6.48 2 2 6.14 2 11.25c0 2.75 1.31 5.22 3.39 6.91L4.5 22l4.18-1.67c1.05.31 2.16.47 3.32.47 5.52 0 10-4.14 10-9.55C22 6.14 17.52 2 12 2zm-.95 14.2l.82-4.1h-2.9l4.08-5.3-.82 4.1h2.9l-4.08 5.3z|0 0 24 24';

export interface ChannelBrandStyle {
  icon: string;
  color: string;
  bg: string;
}

const channelBrandMap: Record<string, ChannelBrandStyle> = {
  bark: { icon: svgBark, color: '#FF3B30', bg: 'rgba(255, 59, 48, 0.13)' },
  telegram: { icon: svgTelegram, color: '#26A5E4', bg: 'rgba(38, 165, 228, 0.14)' },
  wecom: { icon: svgWeCom, color: '#2782D7', bg: 'rgba(39, 130, 215, 0.14)' },
  dingtalk: { icon: svgDingTalk, color: '#0089FF', bg: 'rgba(0, 137, 255, 0.14)' },
  feishu: { icon: svgFeishu, color: '#3370FF', bg: 'rgba(51, 112, 255, 0.14)' },
  serverchan: { icon: svgServerChan, color: '#F59E0B', bg: 'rgba(245, 158, 11, 0.15)' },
  webhook: { icon: symOutlinedWebhook, color: '#7C3AED', bg: 'rgba(124, 58, 237, 0.14)' },
};

/** 后端 /api/channels/types 返回的 icon 是 Material 图标名，这里映射成 SVG；未知名称回退到通知图标 */
const channelIconMap: Record<string, string> = {
  notifications: symOutlinedNotifications,
  notifications_active: symOutlinedNotificationsActive,
  campaign: symOutlinedCampaign,
  send: symOutlinedSend,
  webhook: symOutlinedWebhook,
  mail: symOutlinedMail,
  email: symOutlinedMail,
  chat: symOutlinedChat,
  key: symOutlinedKey,
};

export function channelIcon(name: string | null | undefined): string {
  return (name && channelIconMap[name]) || symOutlinedNotifications;
}

export function channelBrand(type: string | null | undefined, fallbackIcon?: string | null): ChannelBrandStyle {
  if (type && channelBrandMap[type]) {
    return channelBrandMap[type]!;
  }
  return {
    icon: channelIcon(fallbackIcon),
    color: 'var(--q-primary)',
    bg: 'var(--app-selected)',
  };
}
