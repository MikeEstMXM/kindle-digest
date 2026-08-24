import sharp from 'sharp';

/**
 * Bound libvips' memory use. Imported for side effects, once, as early as
 * possible — sharp reads these as global state, so a later call would not
 * retroactively shrink work already done.
 *
 * Both defaults are tuned for a server that processes the same image many
 * times on many cores. This one does neither.
 */
export function configureSharp(concurrency = defaultConcurrency()): void {
  // sharp defaults to a 50 MB operation cache. Every image here is downloaded,
  // decoded, resized and written exactly once, so the cache can never hit — it
  // is 50 MB of permanently resident RSS bought for nothing.
  sharp.cache(false);

  // libvips sizes its thread pool from os.cpus(), which on a Fly shared-cpu-1x
  // reports the *host's* core count rather than the fraction of a core the VM
  // is actually entitled to. The result is a wide pool of workers, each with
  // its own buffers and allocator arena, contending for one vCPU.
  sharp.concurrency(concurrency);
}

/**
 * Digest builds are memory-bound on a small VM, not CPU-bound: wall-clock is
 * dominated by network waits, so trading per-image parallelism for a smaller
 * peak is the right side of the trade. Override with SHARP_CONCURRENCY.
 */
function defaultConcurrency(): number {
  const raw = Number(process.env.SHARP_CONCURRENCY);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1;
}
