import { escapeHtml } from '../util/html.js';

export interface DiagnosticsArticle {
  title: string;
  contentSource?: 'feed' | 'readability';
  failureReason?: 'paywall' | 'js-rendered' | 'http-error' | null;
}

export interface DiagnosticsData {
  folder: string;
  generatedAt: string; // formatted timestamp incl. timezone
  totalFetched: number;
  included: number;
  excluded: number;
  totalGenerationMs: number;
  articles: DiagnosticsArticle[];
}

const SOURCE_LABEL: Record<string, string> = {
  feed: 'RSS feed',
  readability: 'Readability.js fallback',
};

const FAILURE_LABEL: Record<string, string> = {
  paywall: 'Paywall',
  'js-rendered': 'JS-rendered',
  'http-error': 'HTTP error',
};

/** Build the diagnostics page — the final spine item in every EPUB. */
export function buildDiagnosticsPage(data: DiagnosticsData): string {
  const failures = data.articles.filter((a) => a.failureReason);

  const rows = data.articles
    .map((a) => {
      const src = a.contentSource ? SOURCE_LABEL[a.contentSource] : '—';
      const fail = a.failureReason
        ? `<span class="fail">${escapeHtml(FAILURE_LABEL[a.failureReason])}</span>`
        : '<span class="ok">OK</span>';
      return `        <tr><td>${escapeHtml(a.title)}</td><td>${escapeHtml(src)}</td><td>${fail}</td></tr>`;
    })
    .join('\n');

  const failureList =
    failures.length > 0
      ? `<h2>Extraction failures (${failures.length})</h2>\n      <ul>\n` +
        failures
          .map(
            (f) =>
              `        <li>${escapeHtml(f.title)} — ${escapeHtml(
                FAILURE_LABEL[f.failureReason as string],
              )}</li>`,
          )
          .join('\n') +
        `\n      </ul>`
      : `<p>No extraction failures.</p>`;

  const seconds = (data.totalGenerationMs / 1000).toFixed(1);

  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
  <meta charset="utf-8" />
  <title>Diagnostics — ${escapeHtml(data.folder)}</title>
  <link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body class="diag">
  <h1>Diagnostics — ${escapeHtml(data.folder)}</h1>
  <dl>
    <dt>Digest generated at</dt><dd>${escapeHtml(data.generatedAt)}</dd>
    <dt>Total articles fetched</dt><dd>${data.totalFetched}</dd>
    <dt>Included / excluded</dt><dd>${data.included} included, ${data.excluded} excluded</dd>
    <dt>Total generation time</dt><dd>${seconds}s</dd>
  </dl>

  <h2>Per-article content source</h2>
  <table>
    <thead><tr><th>Article</th><th>Content source</th><th>Status</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>

  ${failureList}
</body>
</html>`;
}
