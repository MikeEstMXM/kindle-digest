import { DateTime } from 'luxon';
import type { AppContext } from '../app/context.js';
import { FONTS_DIR } from '../app/context.js';
import { resolveSettings, assertDeliverable } from '../app/settings.js';
import { loadFontBuffers } from '../cover/fontLoader.js';
import { buildFolderDigest } from './orchestrator.js';
import { createTransport, sendEpub } from '../mail/transport.js';

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

/**
 * Build + send the digest for a single folder: fetch unread, drop excluded,
 * generate the EPUB, email it, then mark those items read in Inoreader.
 */
export async function sendFolder(ctx: AppContext, folder: string): Promise<FolderSendResult> {
  const settings = resolveSettings(ctx.env, ctx.settings);
  const delivery = assertDeliverable(settings);
  const isoDate = todayIso(settings.timezone);

  const client = ctx.inoreaderClient();
  const all = await client.getUnreadByFolder(folder);
  const excluded = ctx.selection.excludedIds(isoDate);
  const included = all.filter((a) => !excluded.has(a.itemId));

  if (included.length === 0) {
    return { folder, articleCount: 0, status: 'skipped', message: 'No included articles' };
  }

  const built = await buildFolderDigest(
    folder,
    included,
    all.length,
    {
      isoDate,
      timezone: settings.timezone,
      minChars: ctx.env.fulltextMinChars,
      fonts: loadFontBuffers(FONTS_DIR),
    },
    ctx.runLog,
  );

  const transport = createTransport(delivery);
  await sendEpub(
    transport,
    delivery,
    delivery.to,
    `${folder} — ${isoDate}`,
    { filename: built.filename, content: built.epub },
  );

  await client.markRead(built.itemIds);

  return { folder, articleCount: included.length, status: 'sent' };
}

/** Build + send digests for every top-level folder that has included articles. */
export async function sendAll(ctx: AppContext): Promise<FolderSendResult[]> {
  const client = ctx.inoreaderClient();
  const folders = await client.getFolders();
  const results: FolderSendResult[] = [];
  for (const folder of folders) {
    try {
      results.push(await sendFolder(ctx, folder));
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
