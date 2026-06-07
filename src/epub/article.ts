import { escapeHtml } from '../util/html.js';

export interface ArticlePageInput {
  title: string;
  url: string;
  feedTitle: string;
  author?: string;
  dateLabel?: string;
  /** Already-sanitised XHTML body (full text or inline error notice). */
  bodyXhtml: string;
  /** href of the QR PNG within OEBPS, e.g. "images/qr-1.png". */
  qrHref: string;
}

/** Build a single article page. QR (source link) is appended at the end. */
export function buildArticlePage(input: ArticlePageInput): string {
  const metaParts = [input.feedTitle, input.author, input.dateLabel].filter(Boolean) as string[];
  const meta = metaParts.map(escapeHtml).join(' · ');

  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(input.title)}</title>
  <link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
  <h1 class="article-title">${escapeHtml(input.title)}</h1>
  <div class="article-meta">${meta}</div>
  <div class="article-body">
${input.bodyXhtml}
  </div>
  <div class="source-link">
    <img src="${escapeHtml(input.qrHref)}" alt="QR code linking to the original article" />
    <div class="caption">Open the original: ${escapeHtml(input.url)}</div>
  </div>
</body>
</html>`;
}
