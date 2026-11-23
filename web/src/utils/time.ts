/**
 * 时间工具。
 * 重要：提醒的本地时间（scheduledLocal / nextRunLocal，格式 YYYY-MM-DDTHH:mm）按“提醒的时区”解释，
 * 可能和浏览器时区不同，所以这里只做字符串处理，绝不通过 new Date() 换算。
 * 只有 ISO UTC 绝对时间（createdAt、nextRunAt 等）才用 Date 按浏览器时区显示。
 */
import type { RepeatUnit } from '@/api/types';

export const LOCAL_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

const FALLBACK_TIMEZONES = [
  'UTC', 'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Singapore',
  'Asia/Kolkata', 'Asia/Dubai', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Sao_Paulo',
  'Australia/Sydney', 'Pacific/Auckland',
];

let timezoneCache: string[] | null = null;

export function listTimezones(): string[] {
  if (timezoneCache) return timezoneCache;
  let zones: string[] = [];
  try {
    zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  } catch {
    zones = [];
  }
  if (!zones.length) zones = FALLBACK_TIMEZONES;
  const set = new Set(zones);
  set.add('UTC');
  timezoneCache = [...set].sort((a, b) => (a === 'UTC' ? -1 : b === 'UTC' ? 1 : a.localeCompare(b)));
  return timezoneCache;
}

export function isValidTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** 当前时刻 + N 分钟，在指定时区下的本地时间字符串（YYYY-MM-DDTHH:mm），用于新建提醒的默认值 */
export function nowLocalIn(timezone: string, addMinutes = 0): string {
  const instant = Date.now() + addMinutes * 60_000;
  let zone = timezone;
  if (!isValidTimezone(zone)) zone = 'UTC';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '00';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 'YYYY-MM-DDTHH:mm' → 'YYYY-MM-DD HH:mm'（纯字符串） */
export function formatLocal(local: string | null | undefined): string {
  if (!local) return '—';
  return local.replace('T', ' ');
}

/** 'YYYY-MM-DDTHH:mm' → '11月23日 周一 10:00'（同年省略年份）。星期只做日历计算，不涉及时区换算 */
export function formatLocalFriendly(local: string | null | undefined): string {
  if (!local) return '—';
  const match = LOCAL_DATETIME_RE.exec(local);
  if (!match) return local;
  const [, y, m, d, hh, mm] = match;
  const weekday = WEEKDAYS[new Date(Date.UTC(Number(y), Number(m) - 1, Number(d))).getUTCDay()];
  const sameYear = Number(y) === new Date().getFullYear();
  return `${sameYear ? '' : `${y}年`}${Number(m)}月${Number(d)}日 ${weekday} ${hh}:${mm}`;
}

const instantFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** ISO UTC → 浏览器本地时间 'YYYY/MM/DD HH:mm:ss' */
export function formatInstant(iso: string | null | undefined): string {
  if (!iso) return '—';
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  return instantFormatter.format(time);
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '';
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  const diff = time - Date.now();
  const abs = Math.abs(diff);
  const suffix = diff < 0 ? '前' : '后';
  if (abs < 60_000) return diff < 0 ? '刚刚' : '即将';
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)} 分钟${suffix}`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)} 小时${suffix}`;
  return `${Math.round(abs / 86_400_000)} 天${suffix}`;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days) return `${days} 天 ${hours} 小时`;
  if (hours) return `${hours} 小时 ${minutes} 分钟`;
  if (minutes) return `${minutes} 分钟`;
  return `${s} 秒`;
}

export const REPEAT_UNIT_LABELS: Record<RepeatUnit, string> = {
  hour: '小时',
  day: '天',
  month: '个月',
  year: '年',
};

export function repeatText(isRepeating: boolean, every: number | null, unit: RepeatUnit | null): string {
  if (!isRepeating || !every || !unit) return '单次';
  if (every === 1) return { hour: '每小时', day: '每天', month: '每月', year: '每年' }[unit];
  return `每 ${every} ${REPEAT_UNIT_LABELS[unit]}`;
}
