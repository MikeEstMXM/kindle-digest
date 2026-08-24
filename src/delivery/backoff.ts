/**
 * Retry scheduling for the delivery outbox. Pure and deterministic apart from
 * the injectable jitter source, so the schedule is unit-testable.
 */

/** Attempts before a delivery is marked permanently failed. */
export const DEFAULT_MAX_ATTEMPTS = 5;

/** First retry delay; each subsequent attempt doubles it. */
const BASE_DELAY_MS = 60_000; // 1 min

/** Ceiling so a long-broken SMTP server is retried hourly-ish, not never. */
const MAX_DELAY_MS = 6 * 60 * 60 * 1000; // 6 h

/**
 * Delay before retry number `attempts` (1 = the first retry). Exponential with
 * up to ±20% jitter so repeated failures across folders don't synchronise into
 * a thundering herd against the SMTP server.
 */
export function backoffMs(attempts: number, rand: () => number = Math.random): number {
  const n = Math.max(1, attempts);
  const exponential = Math.min(BASE_DELAY_MS * 2 ** (n - 1), MAX_DELAY_MS);
  const jitter = 1 + (rand() * 0.4 - 0.2);
  return Math.round(Math.min(exponential * jitter, MAX_DELAY_MS));
}

/** Absolute epoch-ms timestamp for the next attempt. */
export function nextAttemptAt(
  attempts: number,
  now: number = Date.now(),
  rand: () => number = Math.random,
): number {
  return now + backoffMs(attempts, rand);
}

/** Whether a delivery has exhausted its retries and should be failed. */
export function isExhausted(attempts: number, maxAttempts: number = DEFAULT_MAX_ATTEMPTS): boolean {
  return attempts >= maxAttempts;
}
