import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from '../src/util/concurrency.js';

describe('mapWithConcurrency', () => {
  it('preserves input order regardless of completion order', async () => {
    const items = [50, 10, 30, 0, 20];
    // Later items finish first, so completion order is the reverse of input.
    const out = await mapWithConcurrency(items, 5, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return `${i}:${ms}`;
    });
    expect(out).toEqual(['0:50', '1:10', '2:30', '3:0', '4:20']);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      3,
      async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
      },
    );
    expect(maxInFlight).toBe(3);
  });

  it('visits every item exactly once', async () => {
    const seen: number[] = [];
    await mapWithConcurrency(
      Array.from({ length: 50 }, (_, i) => i),
      7,
      async (n) => {
        seen.push(n);
      },
    );
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  it('handles an empty list', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });

  it('treats a limit below 1 as serial rather than deadlocking', async () => {
    const out = await mapWithConcurrency([1, 2, 3], 0, async (n) => n * 2);
    expect(out).toEqual([2, 4, 6]);
  });

  it('propagates a rejection so a failed build aborts', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });
});
