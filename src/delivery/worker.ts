import { unlink } from 'node:fs/promises';
import { DateTime } from 'luxon';
import type { AppContext } from '../app/context.js';
import type { DeliveryRow } from '../db/repositories.js';
import { buildFolderEpub, sendBuiltDigest } from '../digest/service.js';
import { classifySmtpError } from '../mail/transport.js';
import { sendFailureAlert } from '../mail/alert.js';
import { isExhausted, nextAttemptAt } from './backoff.js';

/** How often the worker looks for due work. */
const TICK_MS = 30_000;

/**
 * A claim older than this is assumed abandoned by a crash/OOM/restart and is
 * requeued. Must comfortably exceed the longest legitimate build — a 157
 * article weekly digest with per-article fetches can run for many minutes.
 */
const STALE_CLAIM_MS = 45 * 60 * 1000;

/** Keep built EPUBs on the volume this long for re-download, then prune. */
const ARTIFACT_RETENTION_DAYS = 14;

/**
 * Drains the delivery outbox: one row at a time, serially.
 *
 * Serial by design — that is what bounds memory on a 512 MB machine. Each tick
 * claims a single due row, drives it one step through the state machine, and
 * commits the outcome, so an interruption at any point is recoverable rather
 * than silently lost.
 */
export class DeliveryWorker {
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(
    private ctx: AppContext,
    private tickMs: number = TICK_MS,
  ) {}

  start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Recover work abandoned by a crash or restart. Call once on startup. */
  recoverInterrupted(): number {
    const n = this.ctx.delivery.requeueStale(STALE_CLAIM_MS);
    if (n > 0) console.warn(`[delivery] requeued ${n} interrupted deliver${n === 1 ? 'y' : 'ies'}`);
    return n;
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, delay);
  }

  /**
   * Process at most one delivery, then re-arm. Never throws: the whole point
   * is that the loop cannot die the way the old scheduler could.
   */
  async tick(): Promise<void> {
    if (this.running) return this.schedule(this.tickMs);
    this.running = true;
    let didWork = false;
    try {
      const row = this.ctx.delivery.claimDue();
      if (row) {
        didWork = true;
        await this.process(row);
      }
      await this.flushAlerts();
      await this.pruneArtifacts();
    } catch (err) {
      console.error('[delivery] worker tick failed:', err);
    } finally {
      this.running = false;
      // Drain a backlog promptly, then fall back to the idle interval.
      this.schedule(didWork ? 0 : this.tickMs);
    }
  }

  private async process(row: DeliveryRow): Promise<void> {
    if (row.state === 'sending') return this.doSend(row);
    return this.doBuild(row);
  }

  private async doBuild(row: DeliveryRow): Promise<void> {
    try {
      const built = await buildFolderEpub(this.ctx, row.folder, row.digest_date);
      if (!built) {
        this.ctx.delivery.markSkipped(row.id, 'No included articles');
        return;
      }
      this.ctx.delivery.markBuilt(row.id, built.epubPath, built.epubBytes, built.itemIds.length);
      console.log(
        `[delivery] built ${row.folder} ${row.digest_date} ` +
          `(${built.itemIds.length} articles, ${(built.epubBytes / 1024).toFixed(0)} KB)`,
      );
    } catch (err) {
      // A build failure is almost always transient in character (network,
      // memory pressure), so it gets the full retry schedule.
      this.fail(row, err, { hasBuild: false, retry: true });
    }
  }

  private async doSend(row: DeliveryRow): Promise<void> {
    if (!row.epub_path) {
      this.fail(row, new Error('missing built artifact'), { hasBuild: false, retry: true });
      return;
    }
    try {
      const { messageId } = await sendBuiltDigest(
        this.ctx,
        row.folder,
        row.digest_date,
        row.epub_path,
        `${row.folder.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.epub`,
      );
      this.ctx.delivery.markSent(row.id, messageId);
      console.log(`[delivery] sent ${row.folder} ${row.digest_date} (messageId=${messageId})`);
    } catch (err) {
      // Retry only what can plausibly succeed later; a bad password or
      // rejected recipient burns the whole schedule for nothing.
      const retry = classifySmtpError(err) === 'transient';
      this.fail(row, err, { hasBuild: true, retry });
    }
  }

  private fail(row: DeliveryRow, err: unknown, opts: { hasBuild: boolean; retry: boolean }): void {
    const message = err instanceof Error ? err.message : String(err);
    const attempts = row.attempts + 1;
    const retry = opts.retry && !isExhausted(attempts, this.ctx.env.deliveryMaxAttempts);
    const state = this.ctx.delivery.recordFailure(row.id, message, {
      retry,
      hasBuild: opts.hasBuild,
      nextAttemptAt: nextAttemptAt(attempts),
    });
    console.error(
      `[delivery] ${row.folder} ${row.digest_date} attempt ${attempts} failed ` +
        `(${state === 'failed' ? 'giving up' : 'will retry'}): ${message}`,
    );
  }

  /** Send the one-shot alert for anything that ended up permanently failed. */
  private async flushAlerts(): Promise<void> {
    for (const row of this.ctx.delivery.dueForAlert()) {
      try {
        await sendFailureAlert(this.ctx, row);
      } catch (err) {
        // The alert rides the same SMTP path that may itself be broken, so a
        // failure here is expected sometimes. The outbox row remains the
        // durable record either way.
        console.error('[delivery] failure alert could not be sent:', err);
      } finally {
        // Marked regardless, so a broken alert path can never loop.
        this.ctx.delivery.markAlerted(row.id);
      }
    }
  }

  private async pruneArtifacts(): Promise<void> {
    const cutoff = DateTime.now().minus({ days: ARTIFACT_RETENTION_DAYS }).toISODate();
    if (!cutoff) return;
    for (const row of this.ctx.delivery.prunableArtifacts(cutoff)) {
      if (!row.epub_path) continue;
      try {
        await unlink(row.epub_path);
      } catch {
        // Already gone — fall through and clear the reference.
      }
      this.ctx.delivery.clearArtifact(row.id);
    }
  }
}
