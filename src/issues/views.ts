import { DateTime } from 'luxon';
import type { IssueFolder, IssueRow } from '../db/issueRepo.js';
import { escapeHtml } from '../util/html.js';
import { simpleBar, simplePage } from '../web/simple.js';

/** How many of the newest issues get a cover thumbnail; the rest are text only. */
export const THUMBNAILS_SHOWN = 24;

const url = (slug: string, file: string): string =>
  `/issues/${encodeURIComponent(slug)}/${encodeURIComponent(file)}`;

const niceDate = (iso: string): string => {
  const d = DateTime.fromISO(iso);
  return d.isValid ? d.toFormat('ccc d LLL yyyy') : iso;
};

const megabytes = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function issuesIndexPage(folders: IssueFolder[], csrf: string): string {
  const body =
    folders.length === 0
      ? '<p>No issues published yet.</p>'
      : folders
          .map(
            (f) => `<h2>${escapeHtml(f.folder)}</h2>
<p>Latest: ${escapeHtml(niceDate(f.latest.issueDate))} · ${megabytes(f.latest.bytes)} · ${f.count} issue${f.count === 1 ? '' : 's'}</p>
<a class="big" href="${url(f.slug, f.latest.fileName)}">Download latest</a>
<a class="big" href="/issues/${encodeURIComponent(f.slug)}">All ${f.count} issue${f.count === 1 ? '' : 's'}</a>`,
          )
          .join('\n');
  return simplePage('Issues', `${simpleBar(csrf)}<h1>Issues</h1>\n${body}`);
}

export function issueListPage(
  folder: string,
  slug: string,
  issues: IssueRow[],
  csrf: string,
): string {
  const rows = issues
    .map((i, n) => {
      const thumb =
        n < THUMBNAILS_SHOWN
          ? `<td class="thumb"><img src="${url(slug, i.fileName)}/cover.jpg" width="60" alt=""></td>`
          : '';
      return `<table class="issue"><tr>${thumb}<td>
<div class="when">${escapeHtml(niceDate(i.issueDate))}</div>
<div class="muted">${megabytes(i.bytes)}</div>
<a class="big" href="${url(slug, i.fileName)}">Download</a>
</td></tr></table>`;
    })
    .join('\n');
  return simplePage(
    folder,
    `${simpleBar(csrf)}<h1>${escapeHtml(folder)}</h1>
<p class="muted">${issues.length} issue${issues.length === 1 ? '' : 's'}, newest first. <a href="/issues">All folders</a></p>
${rows}`,
  );
}
