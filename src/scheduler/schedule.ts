import { DateTime } from 'luxon';

/**
 * Compute the next delivery instant strictly after `now`, given a local
 * delivery time (HH:mm) and IANA timezone. Returns a UTC-aware DateTime.
 */
export function nextRun(now: DateTime, time: string, timezone: string): DateTime {
  const [h, m] = time.split(':').map((n) => parseInt(n, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) {
    throw new Error(`Invalid delivery time: ${time}`);
  }
  const local = now.setZone(timezone);
  let candidate = local.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  if (candidate <= local) {
    candidate = candidate.plus({ days: 1 });
  }
  return candidate.toUTC();
}

/** Milliseconds from now until the next run (>= 0). */
export function msUntilNextRun(now: DateTime, time: string, timezone: string): number {
  return Math.max(0, nextRun(now, time, timezone).toMillis() - now.toMillis());
}
