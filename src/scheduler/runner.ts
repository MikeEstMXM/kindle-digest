import { DateTime } from 'luxon';
import type { AppContext } from '../app/context.js';
import { resolveSettings } from '../app/settings.js';
import { sendAll } from '../digest/service.js';
import { msUntilNextRun, nextRun } from './schedule.js';

/**
 * Self-re-arming daily scheduler. Sleeps until the next configured delivery
 * time (timezone-aware), runs `sendAll`, then schedules the following day.
 * Re-reads settings on every tick so changes take effect without a restart.
 */
export class DailyScheduler {
  private timer?: NodeJS.Timeout;

  constructor(private ctx: AppContext) {}

  start(): void {
    this.arm();
  }

  stop(): void {
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

  private arm(): void {
    const s = resolveSettings(this.ctx.env, this.ctx.settings);
    let delay: number;
    try {
      delay = msUntilNextRun(DateTime.now(), s.deliveryTime, s.timezone);
    } catch {
      // Bad time config: retry in an hour rather than crash the process.
      delay = 60 * 60 * 1000;
    }
    // setTimeout caps near 24.8 days; our delay is always < 24h so this is safe.
    this.timer = setTimeout(() => {
      void this.fire();
    }, delay);
  }

  private async fire(): Promise<void> {
    try {
      const results = await sendAll(this.ctx);
      const sent = results.filter((r) => r.status === 'sent').length;
      console.log(`[scheduler] Daily digest run complete: ${sent}/${results.length} folders sent.`);
    } catch (err) {
      console.error('[scheduler] Daily digest run failed:', err);
    } finally {
      this.arm(); // schedule tomorrow
    }
  }
}
