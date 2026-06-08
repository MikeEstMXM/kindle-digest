import { escapeHtml } from '../util/html.js';

export interface TocArticle {
  filename: string;
  title: string;
  feedTitle: string;
}

/** Build a visual table-of-contents XHTML page, grouped by feed. */
export function buildTocPage(articles: TocArticle[]): string {
  // Group while preserving insertion order (articles already sorted feed-first).
  const groups = new Map<string, TocArticle[]>();
  for (const a of articles) {
    if (!groups.has(a.feedTitle)) groups.set(a.feedTitle, []);
    groups.get(a.feedTitle)!.push(a);
  }

  const sections = [...groups.entries()]
    .map(
      ([feed, items]) => `    <section>
      <h2 class="toc-feed">${escapeHtml(feed)}</h2>
${items
  .map((a) => `      <a href="${escapeHtml(a.filename)}" class="toc-link">${escapeHtml(a.title)}</a>`)
  .join('\n')}
    </section>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
  <meta charset="utf-8" />
  <title>Contents</title>
  <link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
  <h1 class="toc-heading">Contents</h1>
${sections}
</body>
</html>`;
}
