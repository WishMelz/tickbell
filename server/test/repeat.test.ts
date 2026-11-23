import { describe, expect, it } from 'vitest';
import { calculateNextFutureRun, calculateNextRun } from '../src/common/repeat';
import { epochToLocalInput, localDateTimeToEpoch } from '../src/common/time';

describe('repeat schedule calculations', () => {
  it('handles monthly anchor on 31st across short months and leap years', () => {
    const tz = 'Asia/Shanghai';
    const jan31 = localDateTimeToEpoch('2024-01-31T09:00', tz);
    const feb29 = calculateNextRun(jan31, { every: 1, unit: 'month', timezone: tz, startsAt: jan31 });
    expect(epochToLocalInput(feb29, tz)).toBe('2024-02-29T09:00');

    const mar31 = calculateNextRun(feb29, { every: 1, unit: 'month', timezone: tz, startsAt: jan31 });
    expect(epochToLocalInput(mar31, tz)).toBe('2024-03-31T09:00');

    const apr30 = calculateNextRun(mar31, { every: 1, unit: 'month', timezone: tz, startsAt: jan31 });
    expect(epochToLocalInput(apr30, tz)).toBe('2024-04-30T09:00');
  });

  it('handles yearly leap day anchor', () => {
    const tz = 'UTC';
    const leap = localDateTimeToEpoch('2024-02-29T08:30', tz);
    const y2025 = calculateNextRun(leap, { every: 1, unit: 'year', timezone: tz, startsAt: leap });
    expect(epochToLocalInput(y2025, tz)).toBe('2025-02-28T08:30');
    const y2028 = calculateNextFutureRun(leap, localDateTimeToEpoch('2027-06-01T00:00', tz), {
      every: 1,
      unit: 'year',
      timezone: tz,
      startsAt: leap,
    });
    expect(epochToLocalInput(y2028, tz)).toBe('2028-02-29T08:30');
  });

  it('preserves wall-clock time across DST transitions', () => {
    const tz = 'America/New_York';
    // 2026-03-08 is US DST spring forward
    const beforeDst = localDateTimeToEpoch('2026-03-07T09:00', tz);
    const afterDst = calculateNextRun(beforeDst, { every: 1, unit: 'day', timezone: tz, startsAt: beforeDst });
    expect(epochToLocalInput(afterDst, tz)).toBe('2026-03-08T09:00');
    // 23 real hours elapsed across spring-forward day
    expect((afterDst - beforeDst) / 3_600_000).toBe(23);
  });

  it('skips missed hourly and daily periods cleanly without drift', () => {
    const tz = 'Asia/Shanghai';
    const start = localDateTimeToEpoch('2026-01-01T10:00', tz);
    const now = localDateTimeToEpoch('2026-01-01T17:30', tz);
    const nextHour = calculateNextFutureRun(start, now, { every: 2, unit: 'hour', timezone: tz, startsAt: start });
    expect(epochToLocalInput(nextHour, tz)).toBe('2026-01-01T18:00');

    const later = localDateTimeToEpoch('2026-01-10T11:00', tz);
    const nextDay = calculateNextFutureRun(start, later, { every: 3, unit: 'day', timezone: tz, startsAt: start });
    expect(epochToLocalInput(nextDay, tz)).toBe('2026-01-13T10:00');
  });
});
