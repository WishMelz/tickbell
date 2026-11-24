import { Temporal } from '@js-temporal/polyfill';

const LOCAL_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export function isValidTimezone(timezone: string): boolean {
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

/** `YYYY-MM-DDTHH:mm` interpreted in `timezone` -> UTC epoch ms (DST gaps resolved 'compatible'). */
export function localDateTimeToEpoch(localDateTime: string, timezone: string): number {
  if (!LOCAL_DATE_TIME_PATTERN.test(localDateTime) || !isValidTimezone(timezone)) {
    throw new Error('无效的日期时间或时区');
  }
  const zoned = Temporal.ZonedDateTime.from(`${localDateTime}:00[${timezone}]`, {
    disambiguation: 'compatible',
  });
  return zoned.toInstant().epochMilliseconds;
}

export function epochToLocalInput(epochMilliseconds: number, timezone: string): string {
  return Temporal.Instant.fromEpochMilliseconds(epochMilliseconds)
    .toZonedDateTimeISO(timezone)
    .toPlainDateTime()
    .toString({ smallestUnit: 'minute' });
}

export function epochToIso(epochMilliseconds: number): string {
  return new Date(epochMilliseconds).toISOString();
}

export function formatInTimezone(epochMilliseconds: number, timezone: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(epochMilliseconds));
}
