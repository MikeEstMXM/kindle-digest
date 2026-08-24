/**
 * Samples RSS on an interval and remembers the high-water mark.
 *
 * Peak RSS — not heap, and not a reading taken at the end — is what decides
 * whether Fly OOM-kills a build: memory freed before the build finishes still
 * counted while it was held. A single `process.memoryUsage()` at the end
 * reports whatever survived GC, which is the one number that does not matter.
 */
export class PeakMemory {
  private peak = 0;
  private timer?: NodeJS.Timeout;
  peakSnapshot: NodeJS.MemoryUsage = process.memoryUsage();

  constructor(private readonly intervalMs = 50) {}

  start(): void {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    // Never hold the event loop open on this timer's account: a build that
    // finishes should let the process exit even if stop() was somehow missed.
    this.timer.unref?.();
  }

  /** Current high-water mark in bytes, safe to read while still running. */
  get peakRss(): number {
    return this.peak;
  }

  stop(): number {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.sample();
    return this.peak;
  }

  private sample(): void {
    const m = process.memoryUsage();
    if (m.rss > this.peak) {
      this.peak = m.rss;
      this.peakSnapshot = m;
    }
  }
}
