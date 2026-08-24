import { DateTime } from 'luxon';
import type { AppContext } from '../app/context.js';
import { resolveSettings } from '../app/settings.js';
import { enqueueDue } from '../digest/service.js';
import { msUntilNextRun, nextRun } from './schedule.js';

/**
 * Self-re-arming daily scheduler.
 *
 * It only *queues* work — the DeliveryWorker builds and sends. That split is
 * what makes delivery survivable: firing is now a few fast DB inserts that
 * can't hang on a slow feed or exhaust memory on a large digest, and anything
 * queued outlives a crash because it is a committed row rather than an
 * in-flight promise.
 */
export class DailyScheduler {
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private ctx: AppContext) {}

  start(): void {
    this.stopped = false;
    // Clear any existing timer first: settings saves call stop()/start(), and
    // without this a save landing mid-fire could leave two timers running and
    // double every subsequent day.
    if (this.timer) clearTimeout(this.timer);
    this.arm();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** When the next run is scheduled for, in the configured timezone. */
  nextRunLabel(): string {
    const s = resolveSettings(this.ctx.env, this.ctx.settings);
    return nextRun(DateTime.now(), s.deliveryTime, s.timezone)
      .setZone(s.timezone)
      .toFormat('yyyy-LL-dd HH:mm ZZZZ');
  }

  /**
   * Queue anything that should already have gone out but hasn't — the case
   * where the machine was down or redeploying at the delivery time. Enqueue is
   * idempotent, so this can run on every boot without risking duplicates.
   */
  catchUp(): void {
    const s = resolveSettings(this.ctx.env, this.ctx.settings);
    const now = DateTime.now().setZone(s.timezone);
    const [h, m] = s.deliveryTime.split(':').map((n) => parseInt(n, 10));
    if (Number.isNaN(h) || Number.isNaN(m)) return;

    const todaysSlot = now.set({ hour: h, minute: m, second: 0, millisecond: 0 });
    // If today's slot has passed, today is the candidate; otherwise yesterday's.
    const target = now >= todaysSlot ? now : now.minus({ days: 1 });
    const isoDate = target.toISODate();
    if (!isoDate) return;

    void enqueueDue(this.ctx, isoDate)
      .then((folders) => {
        if (folders.length > 0) {
          console.log(`[scheduler] catch-up queued ${isoDate}: ${folders.join(', ')}`);
        }
      })
      .catch((err) => console.error('[scheduler] catch-up failed:', err));
  }

  private arm(): void {
    if (this.stopped) return;
    const s = resolveSettings(this.ctx.env, this.ctx.settings);
    let delay: number;
    try {
      delay = msUntilNextRun(DateTime.now(), s.deliveryTime, s.timezone);
    } catch {
      // Bad time config: retry in an hour rather than crash the process.
      delay = 60 * 60 * 1000;
    }
    this.timer = setTimeout(() => {
      void this.fire();
    }, delay);
  }

  /**
   * Queue today's due folders. Never throws and always re-arms — the previous
   * version armed only on the happy path, so a single error left the app
   * permanently un-scheduled with nothing but a console line to show for it.
   */
  private async fire(): Promise<void> {
    try {
      const folders = await enqueueDue(this.ctx);
      console.log(
        folders.length > 0
          ? `[scheduler] queued ${folders.length} folder(s): ${folders.join(', ')}`
          : '[scheduler] nothing due today',
      );
    } catch (err) {
      console.error('[scheduler] failed to queue digests:', err);
    } finally {
      this.arm();
    }
  }
}
