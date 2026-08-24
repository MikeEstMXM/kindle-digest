import { describe, it, expect } from 'vitest';
import {
  backoffMs,
  nextAttemptAt,
  isExhausted,
  DEFAULT_MAX_ATTEMPTS,
} from '../src/delivery/backoff.js';

/** Pin jitter to the midpoint so the schedule is deterministic. */
const noJitter = () => 0.5;

describe('backoffMs', () => {
  it('doubles with each attempt', () => {
    const delays = [1, 2, 3, 4].map((n) => backoffMs(n, noJitter));
    expect(delays).toEqual([60_000, 120_000, 240_000, 480_000]);
  });

  it('caps so a long outage keeps retrying rather than drifting to never', () => {
    const capped = backoffMs(50, noJitter);
    expect(capped).toBe(6 * 60 * 60 * 1000);
  });

  it('applies jitter within +/-20% to avoid synchronised retries', () => {
    const low = backoffMs(3, () => 0);
    const high = backoffMs(3, () => 1);
    const mid = backoffMs(3, noJitter);
    expect(low).toBe(Math.round(mid * 0.8));
    expect(high).toBe(Math.round(mid * 1.2));
  });

  it('treats attempt 0 as the first retry', () => {
    expect(backoffMs(0, noJitter)).toBe(backoffMs(1, noJitter));
  });
});

describe('nextAttemptAt', () => {
  it('is an absolute timestamp in the future', () => {
    const now = 1_000_000;
    expect(nextAttemptAt(1, now, noJitter)).toBe(now + 60_000);
  });
});

describe('isExhausted', () => {
  it('stops at the configured attempt cap', () => {
    expect(isExhausted(4, 5)).toBe(false);
    expect(isExhausted(5, 5)).toBe(true);
    expect(isExhausted(6, 5)).toBe(true);
  });

  it('defaults to DEFAULT_MAX_ATTEMPTS', () => {
    expect(isExhausted(DEFAULT_MAX_ATTEMPTS)).toBe(true);
    expect(isExhausted(DEFAULT_MAX_ATTEMPTS - 1)).toBe(false);
  });
});
