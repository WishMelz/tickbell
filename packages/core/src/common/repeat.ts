import { Temporal } from '@js-temporal/polyfill';

export type RepeatUnit = 'minute' | 'hour' | 'day' | 'month' | 'year';
export const REPEAT_UNITS: readonly RepeatUnit[] = ['minute', 'hour', 'day', 'month', 'year'];

export interface RepeatRule {
  every: number;
  unit: RepeatUnit;
  timezone: string;
  startsAt: number;
}

export function calculateNextRun(previousScheduledAt: number, rule: RepeatRule): number {
  const previous = Temporal.Instant.fromEpochMilliseconds(previousScheduledAt).toZonedDateTimeISO(rule.timezone);

  if (rule.unit === 'minute') {
    return previous.add({ minutes: rule.every }).toInstant().epochMilliseconds;
  }

  if (rule.unit === 'hour') {
    return previous.add({ hours: rule.every }).toInstant().epochMilliseconds;
  }

  if (rule.unit === 'day') {
    return previous.add({ days: rule.every }).toInstant().epochMilliseconds;
  }

  const anchorDay = Temporal.Instant.fromEpochMilliseconds(rule.startsAt).toZonedDateTimeISO(rule.timezone).day;
  const targetMonth = previous
    .toPlainDate()
    .with({ day: 1 })
    .add(rule.unit === 'month' ? { months: rule.every } : { years: rule.every });
  const targetDate = targetMonth.with({ day: Math.min(anchorDay, targetMonth.daysInMonth) });
  const targetDateTime = targetDate.toPlainDateTime(previous.toPlainTime());

  return targetDateTime
    .toZonedDateTime(rule.timezone, {
      disambiguation: 'compatible',
    })
    .toInstant().epochMilliseconds;
}

/** Next occurrence strictly after `now` (missed periods are skipped, no drift). */
export function calculateNextFutureRun(previousScheduledAt: number, now: number, rule: RepeatRule): number {
  const previous = Temporal.Instant.fromEpochMilliseconds(previousScheduledAt).toZonedDateTimeISO(rule.timezone);
  const current = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(rule.timezone);
  const firstNextRun = calculateNextRun(previousScheduledAt, rule);
  if (firstNextRun > now) return firstNextRun;

  if (rule.unit === 'minute' || rule.unit === 'hour') {
    const stepMs = rule.unit === 'minute' ? 60 * 1000 : 60 * 60 * 1000;
    const interval = rule.every * stepMs;
    const addDuration = (count: number) =>
      rule.unit === 'minute'
        ? previous.add({ minutes: count * rule.every }).toInstant().epochMilliseconds
        : previous.add({ hours: count * rule.every }).toInstant().epochMilliseconds;
    const elapsed = now - firstNextRun;
    let periods = Math.max(1, Math.floor(elapsed / interval) + 1);
    let nextRunAt = addDuration(periods);
    while (nextRunAt <= now) {
      periods += 1;
      nextRunAt = addDuration(periods);
    }
    while (periods > 1) {
      const previousRunAt = addDuration(periods - 1);
      if (previousRunAt <= now) break;
      periods -= 1;
      nextRunAt = previousRunAt;
    }
    return nextRunAt;
  }

  if (rule.unit === 'day') {
    const calendarDays = previous.toPlainDate().until(current.toPlainDate(), { largestUnit: 'days' }).days;
    const periods = Math.max(1, Math.floor(calendarDays / rule.every));
    let nextRunAt = previous.add({ days: periods * rule.every }).toInstant().epochMilliseconds;
    if (nextRunAt <= now) {
      nextRunAt = previous.add({ days: (periods + 1) * rule.every }).toInstant().epochMilliseconds;
    }
    return nextRunAt;
  }

  const calendarMonths = (current.year - previous.year) * 12 + current.month - previous.month;
  const intervalMonths = rule.every * (rule.unit === 'year' ? 12 : 1);
  const periods = Math.max(1, Math.floor(calendarMonths / intervalMonths));
  const targetMonth = previous.toPlainDate().with({ day: 1 }).add({
    months: periods * intervalMonths,
  });
  const anchorDay = Temporal.Instant.fromEpochMilliseconds(rule.startsAt).toZonedDateTimeISO(rule.timezone).day;
  const targetDate = targetMonth.with({ day: Math.min(anchorDay, targetMonth.daysInMonth) });
  let nextRunAt = targetDate
    .toPlainDateTime(previous.toPlainTime())
    .toZonedDateTime(rule.timezone, { disambiguation: 'compatible' })
    .toInstant().epochMilliseconds;
  if (nextRunAt <= now) {
    const nextTargetMonth = targetMonth.add({ months: intervalMonths });
    const nextTargetDate = nextTargetMonth.with({
      day: Math.min(anchorDay, nextTargetMonth.daysInMonth),
    });
    nextRunAt = nextTargetDate
      .toPlainDateTime(previous.toPlainTime())
      .toZonedDateTime(rule.timezone, { disambiguation: 'compatible' })
      .toInstant().epochMilliseconds;
  }
  return nextRunAt;
}
