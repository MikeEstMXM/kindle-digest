/**
 * Articles extracted and rendered in parallel during a digest build.
 *
 * Builds are network-bound, not CPU-bound, so the previous serial version spent
 * most of its wall-clock idle. Benchmarked against the 512 MB VM profile for
 * both elapsed time and peak RSS; override with BUILD_CONCURRENCY.
 */
export const DEFAULT_BUILD_CONCURRENCY = 4;

/**
 * Map over items with at most `limit` in flight, preserving input order.
 *
 * The digest build is dominated by network waits — one page fetch per article
 * plus up to five image fetches, each hundreds of milliseconds — so running
 * them strictly serially leaves nearly all of the wall-clock as idle time.
 *
 * `limit` is deliberately a hard cap rather than an unbounded `Promise.all`:
 * each in-flight article holds a jsdom tree and a decoded image, so
 * concurrency trades peak memory for speed on a 512 MB VM. Results are written
 * into a pre-sized array, so output order never depends on completion order.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  const width = Math.max(1, Math.min(Math.floor(limit), items.length));
  let next = 0;

  // Each worker pulls the next index until the queue drains. A rejection
  // propagates out of Promise.all and aborts the build, matching the serial
  // behaviour this replaced.
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };

  await Promise.all(Array.from({ length: width }, worker));
  return results;
}
