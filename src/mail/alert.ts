import { DateTime } from 'luxon';
import type { AppContext } from '../app/context.js';
import type { DeliveryRow } from '../db/repositories.js';
import { resolveSettings, assertDeliverable } from '../app/settings.js';
import { createTransport, sendPlainMail } from './transport.js';

/**
 * Email the operator when a digest has permanently failed to deliver.
 *
 * Deliberately plain text and self-contained: it has to be readable on a phone
 * and it is the only notification channel, so it carries enough context to act
 * on without opening a shell. Note the inherent limitation — this rides the
 * same SMTP path that may be the thing that's broken, which is why the
 * `delivery` row, not this email, is the system of record.
 */
export async function sendFailureAlert(ctx: AppContext, row: DeliveryRow): Promise<void> {
  const settings = resolveSettings(ctx.env, ctx.settings);
  const delivery = assertDeliverable(settings);
  const to = ctx.env.alertEmail ?? delivery.from;

  const when = (ms: number | null): string =>
    ms ? DateTime.fromMillis(ms).setZone(settings.timezone).toFormat('yyyy-LL-dd HH:mm ZZZZ') : '—';

  const recentRuns = ctx.runLog
    .recent(5)
    .map((r) => {
      // Peak memory is here because OOM is a plausible cause of a failed run,
      // and this alert is the one place the failure is actually read.
      const mem =
        r.peak_rss_bytes === null
          ? ''
          : ` ${(r.peak_rss_bytes / 1024 / 1024).toFixed(0)}MB peak` +
            (r.concurrency === null ? '' : ` @c${r.concurrency}`);
      return (
        `  ${r.digest_date}  ${r.folder.padEnd(16)} ${r.status.padEnd(8)} ` +
        `${String(r.included).padStart(4)} articles${mem}` +
        `${r.error ? `\n      ${r.error.split('\n')[0]}` : ''}`
      );
    })
    .join('\n');

  const body = [
    `Digest delivery failed after ${row.attempts} attempt(s).`,
    '',
    `  Folder:   ${row.folder}`,
    `  Date:     ${row.digest_date}`,
    `  Articles: ${row.article_count ?? 'unknown'}`,
    `  EPUB:     ${row.epub_bytes ? `${(row.epub_bytes / 1024).toFixed(0)} KB at ${row.epub_path}` : 'not built'}`,
    `  First queued: ${when(row.created_at)}`,
    `  Last attempt: ${when(row.updated_at)}`,
    '',
    'Last error:',
    `  ${row.last_error ?? 'unknown'}`,
    '',
    'Recent runs:',
    recentRuns || '  (none)',
    '',
    row.epub_path
      ? 'The built EPUB is still on the volume — fix the cause and it will be re-sent without rebuilding.'
      : 'No EPUB was produced; the failure happened during the build.',
  ].join('\n');

  const transport = createTransport(delivery);
  try {
    await sendPlainMail(
      transport,
      delivery,
      to,
      `[kindle-digest] delivery failed: ${row.folder} ${row.digest_date}`,
      body,
    );
  } finally {
    transport.close();
  }
}
