import { escapeHtml } from '../util/html.js';

export interface SectionArticle {
  filename: string;
  title: string;
}

/** Build a feed section index XHTML page listing its articles. */
export function buildSectionIndexPage(feedTitle: string, articles: SectionArticle[]): string {
  const items = articles
    .map(
      (a) =>
        `    <li><a href="${escapeHtml(a.filename)}" class="toc-link">${escapeHtml(a.title)}</a></li>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(feedTitle)}</title>
  <link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
  <h1 class="toc-heading">${escapeHtml(feedTitle)}</h1>
  <ul class="section-article-list">
${items}
  </ul>
  <div class="calibre_navbar">| <a href="toc.xhtml">Main</a> |</div>
</body>
</html>`;
}
