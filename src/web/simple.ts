import { escapeHtml } from '../util/html.js';

/**
 * Plain pages for the places a Kindle's basic browser has to work: sign-in,
 * first-time setup and the issue archive. No JavaScript, no CSS variables, no
 * flexbox — just big type and big tap targets that an e-ink browser renders
 * the same as a desktop one.
 */

const STYLE = `
  body { font-family: Georgia, serif; font-size: 22px; line-height: 1.4; margin: 0; padding: 12px; color: #000; background: #fff; }
  h1 { font-size: 30px; margin: 8px 0 14px; }
  h2 { font-size: 26px; margin: 24px 0 8px; }
  p { margin: 12px 0; }
  label { display: block; font-weight: bold; margin: 18px 0 6px; }
  input[type=text], input[type=password] { width: 100%; box-sizing: border-box; font-size: 24px; padding: 12px; border: 2px solid #000; background: #fff; color: #000; }
  input[type=checkbox] { width: 28px; height: 28px; vertical-align: middle; margin: 0 8px 0 0; }
  label.check { font-weight: normal; margin: 18px 0; }
  button, a.big { display: block; width: 100%; box-sizing: border-box; font-family: inherit; font-size: 26px; padding: 18px 12px; margin: 12px 0; border: 3px solid #000; background: #fff; color: #000; text-align: center; text-decoration: none; }
  a.small, button.small { display: inline-block; width: auto; font-size: 20px; padding: 10px 14px; margin: 4px 8px 4px 0; border-width: 2px; }
  .bar { border-bottom: 2px solid #000; padding-bottom: 8px; margin-bottom: 8px; }
  .bar form { display: inline; }
  .msg { border: 3px solid #000; padding: 12px; margin: 12px 0; font-weight: bold; }
  .muted { font-size: 18px; }
  table.issue { width: 100%; border-collapse: collapse; border-top: 1px solid #000; margin-top: 8px; }
  table.issue td { vertical-align: top; padding: 8px 8px 8px 0; }
  td.thumb { width: 64px; }
  td.thumb img { width: 60px; height: auto; border: 1px solid #000; }
  .when { font-size: 24px; font-weight: bold; }
`;

export function simplePage(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Kindle Digest</title><style>${STYLE}</style></head>
<body>${body}</body></html>`;
}

/** The top bar of the archive pages: where to go, and how to sign out. */
export function simpleBar(csrf: string): string {
  return `<div class="bar">
<a class="big small" href="/issues">Issues</a><a class="big small" href="/">Dashboard</a>
<form method="post" action="/logout"><input type="hidden" name="_csrf" value="${escapeHtml(csrf)}"><button class="small" type="submit">Sign out</button></form>
</div>`;
}
