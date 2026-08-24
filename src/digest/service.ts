import { DateTime } from 'luxon';
import type { AppContext } from '../app/context.js';
import { FONTS_DIR } from '../app/context.js';
import { resolveSettings, assertDeliverable } from '../app/settings.js';
import { loadFontBuffers } from '../cover/fontLoader.js';
import { buildFolderDigest, type BuiltDigest } from './orchestrator.js';
import { createTransport, sendEpub } from '../mail/transport.js';

export type { BuiltDigest };

export interface FolderSendResult {
  folder: string;
  articleCount: number;
  status: 'queued' | 'sent' | 'skipped' | 'error';
  message?: string;
}

/** Today's ISO date in the configured timezone. */
export function todayIso(timezone: string): string {
  return DateTime.now().setZone(timezone).toISODate()!;
}

/** Build the EPUB for one folder without sending. Returns null if there are no included articles. */
export async function buildFolderEpub(
  ctx: AppContext,
  folder: string,
  dateOverride?: string,
): Promise<BuiltDigest | null> {
  const settings = resolveSettings(ctx.env, ctx.settings);
  const isoDate = dateOverride ?? todayIso(settings.timezone);

  const folderCfg = ctx.folderSettings.get(folder);
  const windowMs = folderCfg.cadence === 'weekly' ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;

  // Anchor the window to the END of the target date (midnight of the next day)
  // so retroactive digests include articles published on that date.
  const anchorMs = DateTime.fromISO(isoDate, { zone: settings.timezone })
    .plus({ days: 1 })
    .toMillis();
  const sinceMs = anchorMs - windowMs;

  const client = ctx.readerClient();
  const all = await client.getRecentByFolder(folder, sinceMs);
  const excluded = ctx.selection.excludedIds(isoDate);
  const included = all
    .filter((a) => !excluded.has(a.itemId))
    .sort((a, b) => {
      const fc = a.feedTitle.localeCompare(b.feedTitle);
      if (fc !== 0) return fc;
      return (b.publishedMs ?? 0) - (a.publishedMs ?? 0);
    });

  if (included.length === 0) return null;

  return buildFolderDigest(
    folder,
    included,
    all.length,
    {
      isoDate,
      timezone: settings.timezone,
      minChars: ctx.env.fulltextMinChars,
      fonts: loadFontBuffers(FONTS_DIR),
      outDir: ctx.env.digestDir,
      coverTemplate: folderCfg.coverTemplate,
      coverTheme: folderCfg.coverTheme,
    },
    ctx.runLog,
  );
}

/** Build EPUBs for all folders that have included articles. */
export async function buildAllEpubs(
  ctx: AppContext,
  dateOverride?: string,
): Promise<BuiltDigest[]> {
  const folders = await ctx.readerClient().getFolders();
  const results: BuiltDigest[] = [];
  for (const folder of folders) {
    const built = await buildFolderEpub(ctx, folder, dateOverride);
    if (built) results.push(built);
  }
  return results;
}

/**
 * Mail an already-built EPUB. Streams the attachment off disk and only
 * resolves once the SMTP server has confirmed it accepted the recipient.
 */
export async function sendBuiltDigest(
  ctx: AppContext,
  folder: string,
  isoDate: string,
  epubPath: string,
  filename: string,
): Promise<{ messageId: string | null }> {
  const settings = resolveSettings(ctx.env, ctx.settings);
  const delivery = assertDeliverable(settings);

  const transport = createTransport(delivery);
  try {
    const outcome = await sendEpub(transport, delivery, delivery.to, `${folder} — ${isoDate}`, {
      filename,
      path: epubPath,
    });
    return { messageId: outcome.messageId };
  } finally {
    transport.close();
  }
}

/**
 * Queue one folder for delivery. Returns immediately — the worker builds and
 * sends. Idempotent: re-queueing an in-flight or completed digest is a no-op.
 */
export function enqueueFolder(ctx: AppContext, folder: string, dateOverride?: string): string {
  const settings = resolveSettings(ctx.env, ctx.settings);
  const isoDate = dateOverride ?? todayIso(settings.timezone);
  ctx.delivery.enqueue(isoDate, folder);
  return isoDate;
}

/**
 * Queue every folder due on `isoDate`, respecting per-folder cadence. Used by
 * the scheduler, the startup catch-up, and the manual "Send all" button.
 * Returns the folders queued.
 */
export async function enqueueDue(
  ctx: AppContext,
  dateOverride?: string,
  opts: { ignoreCadence?: boolean } = {},
): Promise<string[]> {
  const settings = resolveSettings(ctx.env, ctx.settings);
  const isoDate = dateOverride ?? todayIso(settings.timezone);
  const dow = DateTime.fromISO(isoDate, { zone: settings.timezone }).weekday % 7; // 0=Sun

  const folders = await ctx.readerClient().getFolders();
  const queued: string[] = [];
  for (const folder of folders) {
    const cfg = ctx.folderSettings.get(folder);
    if (!opts.ignoreCadence && cfg.cadence === 'weekly' && cfg.deliveryDay !== dow) continue;
    ctx.delivery.enqueue(isoDate, folder);
    queued.push(folder);
  }
  return queued;
}
