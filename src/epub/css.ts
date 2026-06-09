/** Stylesheet for article + diagnostics pages (cover carries its own inline CSS). */
export function contentCss(): string {
  return `body { margin: 0 5%; font-family: Georgia, 'Times New Roman', serif; line-height: 1.5; }
body.article-page { page-break-before: always; break-before: page; }
.article-header { margin-bottom: 1.4em; border-bottom: 1px solid #ccc; padding-bottom: 0.6em; }
.back-link { font-size: 0.75em; color: #555; text-decoration: none; display: block; margin-bottom: 0.5em; }
h1.article-title { font-size: 1.5em; line-height: 1.2; margin: 0.6em 0 0.2em; }
.article-meta { color: #555; font-size: 0.85em; margin-bottom: 0; }
.article-meta a { color: #555; }
.toc-heading { font-size: 1.6em; margin-bottom: 1em; }
.toc-feed { font-size: 0.9em; font-variant: small-caps; letter-spacing: 0.04em; margin: 1.4em 0 0.3em; color: #444; border-bottom: 1px solid #ddd; padding-bottom: 0.2em; }
.toc-link { display: block; padding: 0.3em 0; text-decoration: none; color: #1a1a1a; font-size: 0.95em; }
.article-body img { max-width: 100%; height: auto; }
.article-body figure { margin: 1em 0; }
.extract-error { border: 1px solid #999; background: #f2f2f2; padding: 0.8em 1em; margin: 1em 0; }
.extract-error .src-url { word-break: break-all; font-family: monospace; font-size: 0.85em; }
.source-link { margin-top: 2em; text-align: center; page-break-inside: avoid; }
.source-link img { width: 200px; height: 200px; }
.source-link .caption { font-size: 0.8em; color: #555; margin-top: 0.4em; word-break: break-all; }
hr.article-sep { border: 0; border-top: 1px solid #ccc; margin: 2em 0; }
.calibre_navbar { font-family: monospace; font-size: 0.75em; text-align: center; margin: 1.5em 0 0.5em; color: #555; }
.calibre_navbar a { color: #333; }
.nav-disabled { color: #aaa; }
.section-article-list { list-style: none; padding: 0; margin: 0; }

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
