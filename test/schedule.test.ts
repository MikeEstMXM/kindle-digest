import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import { nextRun, msUntilNextRun } from '../src/scheduler/schedule.js';

describe('nextRun', () => {
  it('schedules later the same day when the time is still ahead', () => {
    const now = DateTime.fromISO('2026-06-07T05:00:00', { zone: 'America/New_York' });
    const run = nextRun(now, '06:30', 'America/New_York');
    expect(run.setZone('America/New_York').toFormat('yyyy-LL-dd HH:mm')).toBe('2026-06-07 06:30');
  });

  it('rolls to tomorrow when the time has passed', () => {
    const now = DateTime.fromISO('2026-06-07T07:00:00', { zone: 'America/New_York' });
    const run = nextRun(now, '06:30', 'America/New_York');
    expect(run.setZone('America/New_York').toFormat('yyyy-LL-dd HH:mm')).toBe('2026-06-08 06:30');
  });

  it('respects the configured timezone, not the host zone', () => {
    const now = DateTime.fromISO('2026-06-07T05:00:00Z', { zone: 'utc' });
    // 05:00Z is 14:00 in Tokyo on 2026-06-07, so 06:30 Tokyo has passed → next day.
    const run = nextRun(now, '06:30', 'Asia/Tokyo');
    expect(run.setZone('Asia/Tokyo').toFormat('yyyy-LL-dd HH:mm')).toBe('2026-06-08 06:30');
    expect(run.toUTC().toFormat('yyyy-LL-dd HH:mm')).toBe('2026-06-07 21:30');
  });

  it('handles DST spring-forward without throwing', () => {
    const now = DateTime.fromISO('2026-03-08T01:00:00', { zone: 'America/New_York' });
    const run = nextRun(now, '06:30', 'America/New_York');
    expect(run.isValid).toBe(true);
  });

  it('msUntilNextRun is non-negative', () => {
    const now = DateTime.now();
    expect(msUntilNextRun(now, '06:30', 'America/New_York')).toBeGreaterThanOrEqual(0);
  });

  it('rejects malformed times', () => {
    expect(() => nextRun(DateTime.now(), 'nope', 'America/New_York')).toThrow();
  });
});
