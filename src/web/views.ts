import { escapeHtml } from '../util/html.js';
import type { NormalizedArticle } from '../inoreader/types.js';
import type { EffectiveSettings } from '../app/settings.js';
import type { FolderSendResult } from '../digest/service.js';

const STYLE = `
  :root { --fg:#1a1a1a; --muted:#666; --line:#ddd; --accent:#1a6; --bg:#fafafa; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; margin:0; color:var(--fg); background:var(--bg); }
  header { background:#1a1a1a; color:#fff; padding:14px 20px; display:flex; align-items:center; justify-content:space-between; }
  header a { color:#fff; text-decoration:none; margin-left:16px; opacity:0.85; }
  header a:hover { opacity:1; }
  main { max-width:880px; margin:0 auto; padding:20px; }
  .folder { background:#fff; border:1px solid var(--line); border-radius:8px; margin-bottom:20px; overflow:hidden; }
  .folder h2 { margin:0; padding:12px 16px; font-size:18px; background:#f3f3f3; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; }
  .article { display:flex; gap:12px; padding:10px 16px; border-bottom:1px solid #f0f0f0; align-items:flex-start; }
  .article:last-child { border-bottom:0; }
  .article .meta { flex:1; }
  .article .title { font-weight:600; }
  .article .sub { color:var(--muted); font-size:13px; margin-top:2px; }
  .article.excluded { opacity:0.45; }
  button { font:inherit; padding:6px 12px; border:1px solid #1a1a1a; background:#1a1a1a; color:#fff; border-radius:6px; cursor:pointer; }
  button.secondary { background:#fff; color:#1a1a1a; }
  .toggle { padding:4px 10px; font-size:13px; }
  label.field { display:block; margin:12px 0; }
  label.field span { display:block; font-weight:600; margin-bottom:4px; }
  input, select { font:inherit; padding:8px; width:100%; border:1px solid var(--line); border-radius:6px; }
  .notice { background:#fff8e1; border:1px solid #f0d000; padding:12px 16px; border-radius:8px; margin-bottom:16px; }
  .result { padding:10px 16px; border-radius:6px; margin:8px 0; }
  .result.sent { background:#e8f7ee; } .result.error { background:#fde8e8; } .result.skipped { background:#eee; }
  .muted { color:var(--muted); }
`;

export function layout(title: string, body: string, navConnected: boolean): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} — Kindle Digest</title>
<script src="/vendor/htmx.min.js"></script>
<style>${STYLE}</style>
</head><body>
<header>
  <strong>📚 Kindle Digest</strong>
  <nav>
    <a href="/">Dashboard</a>
    <a href="/settings">Settings</a>
    ${navConnected ? '<a href="/auth/inoreader">Reconnect</a>' : '<a href="/auth/inoreader">Connect Inoreader</a>'}
  </nav>
</header>
<main>${body}</main>
</body></html>`;
}

export function connectPrompt(reason: string): string {
  return `<div class="notice"><strong>Inoreader not connected.</strong> ${escapeHtml(reason)}</div>
  <p><a href="/auth/inoreader"><button>Connect Inoreader</button></a></p>`;
}

export interface RowFields {
  itemId: string;
  title: string;
  feedTitle: string;
}

function renderRow(date: string, folder: string, f: RowFields, included: boolean): string {
  const cls = included ? 'article' : 'article excluded';
  const label = included ? 'Included' : 'Excluded';
  const btnClass = included ? 'toggle' : 'toggle secondary';
  const vals = {
    date,
    itemId: f.itemId,
    folder,
    title: f.title,
    feedTitle: f.feedTitle,
    included: !included,
  };
  return `<div class="${cls}" id="art-${escapeHtml(f.itemId)}">
    <div class="meta">
      <div class="title">${escapeHtml(f.title)}</div>
      <div class="sub">${escapeHtml(f.feedTitle)}</div>
    </div>
    <button class="${btnClass}"
      hx-post="/toggle"
      hx-vals='${escapeHtml(JSON.stringify(vals))}'
      hx-target="#art-${escapeHtml(f.itemId)}" hx-swap="outerHTML">${label}</button>
  </div>`;
}

/** Re-render a single row (used by the HTMX toggle endpoint). */
export function articleRowFragment(
  date: string,
  folder: string,
  f: RowFields,
  included: boolean,
): string {
  return renderRow(date, folder, f, included);
}

export interface DashboardFolder {
  folder: string;
  articles: { article: NormalizedArticle; included: boolean }[];
}

export function dashboard(date: string, folders: DashboardFolder[]): string {
  if (folders.length === 0) {
    return `<p class="muted">No unread articles in any folder right now. 🎉</p>`;
  }
  const sections = folders
    .map((f) => {
      const includedCount = f.articles.filter((x) => x.included).length;
      const rows = f.articles
        .map((x) =>
          renderRow(
            date,
            f.folder,
            { itemId: x.article.itemId, title: x.article.title, feedTitle: x.article.feedTitle },
            x.included,
          ),
        )
        .join('\n');
      return `<section class="folder">
      <h2><span>${escapeHtml(f.folder)} <span class="muted">(${includedCount}/${f.articles.length})</span></span>
        <button hx-post="/send/${encodeURIComponent(f.folder)}" hx-target="#send-result" hx-swap="innerHTML">Send now</button>
      </h2>
      ${rows}
    </section>`;
    })
    .join('\n');

  return `<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
      <div>Digest for <strong>${escapeHtml(date)}</strong></div>
      <button hx-post="/send-all" hx-target="#send-result" hx-swap="innerHTML">Send all</button>
    </div>
    <div id="send-result"></div>
    ${sections}`;
}

export function sendResults(results: FolderSendResult[]): string {
  return results
    .map((r) => {
      const msg =
        r.status === 'sent'
          ? `Sent ${r.articleCount} article(s).`
          : r.status === 'skipped'
            ? r.message ?? 'Skipped.'
            : `Error: ${r.message ?? 'unknown'}`;
      return `<div class="result ${r.status}"><strong>${escapeHtml(r.folder)}:</strong> ${escapeHtml(msg)}</div>`;
    })
    .join('\n');
}

export function settingsPage(s: EffectiveSettings, timezones: string[]): string {
  const tzOptions = timezones
    .map(
      (tz) => `<option value="${escapeHtml(tz)}"${tz === s.timezone ? ' selected' : ''}>${escapeHtml(tz)}</option>`,
    )
    .join('');
  return `<h1>Settings</h1>
  <div class="notice">⚠ <strong>Kindle whitelist required.</strong> Add your SMTP <em>from</em> address
    (<code>${escapeHtml(s.smtp.from ?? 'not set')}</code>) to Amazon's
    <em>Approved Personal Document E-mail List</em>, or deliveries are silently dropped.</div>
  <form method="post" action="/settings">
    <label class="field"><span>Kindle email (@kindle.com)</span>
      <input name="kindleEmail" type="email" value="${escapeHtml(s.kindleEmail ?? '')}" placeholder="you@kindle.com" /></label>
    <label class="field"><span>Delivery time (HH:mm, 24h)</span>
      <input name="deliveryTime" value="${escapeHtml(s.deliveryTime)}" placeholder="06:30" /></label>
    <label class="field"><span>Timezone</span><select name="timezone">${tzOptions}</select></label>
    <h2>SMTP</h2>
    <label class="field"><span>Host</span><input name="smtpHost" value="${escapeHtml(s.smtp.host ?? '')}" /></label>
    <label class="field"><span>Port</span><input name="smtpPort" value="${escapeHtml(String(s.smtp.port ?? 587))}" /></label>
    <label class="field"><span>Secure (TLS)</span>
      <select name="smtpSecure"><option value="false"${!s.smtp.secure ? ' selected' : ''}>false (STARTTLS)</option>
      <option value="true"${s.smtp.secure ? ' selected' : ''}>true</option></select></label>
    <label class="field"><span>Username</span><input name="smtpUser" value="${escapeHtml(s.smtp.user ?? '')}" /></label>
    <label class="field"><span>Password</span><input name="smtpPass" type="password" value="${escapeHtml(s.smtp.pass ?? '')}" /></label>
    <label class="field"><span>From address (must be Amazon-whitelisted)</span>
      <input name="smtpFrom" type="email" value="${escapeHtml(s.smtp.from ?? '')}" /></label>
    <p><button type="submit">Save settings</button></p>
  </form>
  <p class="muted">Inoreader: ${s.inoreaderConfigured ? 'API credentials configured (env).' : 'Set INOREADER_CLIENT_ID/SECRET in the environment.'}</p>`;
}
