/** Stylesheet for article + diagnostics pages (cover carries its own inline CSS). */
export function contentCss(): string {
  return `body { margin: 0 5%; font-family: Georgia, 'Times New Roman', serif; line-height: 1.5; }
h1.article-title { font-size: 1.5em; line-height: 1.2; margin: 1em 0 0.2em; }
.article-meta { color: #555; font-size: 0.85em; margin-bottom: 1.2em; }
.article-meta a { color: #555; }
.article-body img { max-width: 100%; height: auto; }
.article-body figure { margin: 1em 0; }
.extract-error { border: 1px solid #999; background: #f2f2f2; padding: 0.8em 1em; margin: 1em 0; }
.extract-error .src-url { word-break: break-all; font-family: monospace; font-size: 0.85em; }
.source-link { margin-top: 2em; text-align: center; page-break-inside: avoid; }
.source-link img { width: 200px; height: 200px; }
.source-link .caption { font-size: 0.8em; color: #555; margin-top: 0.4em; word-break: break-all; }
hr.article-sep { border: 0; border-top: 1px solid #ccc; margin: 2em 0; }

/* Diagnostics */
.diag h1 { font-size: 1.4em; }
.diag table { border-collapse: collapse; width: 100%; font-size: 0.85em; }
.diag th, .diag td { border: 1px solid #ccc; padding: 4px 6px; text-align: left; vertical-align: top; }
.diag .ok { color: #060; }
.diag .fail { color: #900; }
.diag dl { margin: 0 0 1em; }
.diag dt { font-weight: bold; }
.diag dd { margin: 0 0 0.4em; }`;
}
