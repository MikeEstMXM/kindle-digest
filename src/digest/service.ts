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
  status: 'sent' | 'skipped' | 'error';
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
 * Build + send the digest for a single folder: fetch unread, drop excluded,
 * generate the EPUB, email it, then mark those items read.
 */
export async function sendFolder(
  ctx: AppContext,
  folder: string,
  dateOverride?: string,
): Promise<FolderSendResult> {
  const settings = resolveSettings(ctx.env, ctx.settings);
  const delivery = assertDeliverable(settings);
  const isoDate = dateOverride ?? todayIso(settings.timezone);

  const built = await buildFolderEpub(ctx, folder, dateOverride);
  if (!built) {
    return { folder, articleCount: 0, status: 'skipped', message: 'No included articles' };
  }

  const transport = createTransport(delivery);
  await sendEpub(
    transport,
    delivery,
    delivery.to,
    `${folder} — ${isoDate}`,
    { filename: built.filename, content: built.epub },
  );

  return { folder, articleCount: built.itemIds.length, status: 'sent' };
}

/** Build + send digests for every top-level folder that has included articles. */
export async function sendAll(ctx: AppContext, dateOverride?: string): Promise<FolderSendResult[]> {
  const client = ctx.readerClient();
  const folders = await client.getFolders();
  const results: FolderSendResult[] = [];
  for (const folder of folders) {
    try {
      results.push(await sendFolder(ctx, folder, dateOverride));
    } catch (err) {
      results.push({
        folder,
        articleCount: 0,
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
