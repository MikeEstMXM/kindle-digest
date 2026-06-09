import { escapeHtml } from '../util/html.js';
import type { NormalizedArticle } from '../reader/types.js';
import type { EffectiveSettings } from '../app/settings.js';
import type { FolderSendResult } from '../digest/service.js';
import type { Feed, FolderSettings } from '../db/feedRepos.js';

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
  .feed-row { display:flex; gap:12px; align-items:center; padding:10px 16px; border-bottom:1px solid #f0f0f0; }
  .feed-row:last-child { border-bottom:0; }
  .feed-row .meta { flex:1; }
  .feed-row .feed-title { font-weight:600; }
  .feed-row .feed-url { color:var(--muted); font-size:12px; word-break:break-all; }
  .feed-row .feed-status { font-size:12px; color:var(--muted); }
  .feed-row .feed-status.error { color:#c00; }
  button { font:inherit; padding:6px 12px; border:1px solid #1a1a1a; background:#1a1a1a; color:#fff; border-radius:6px; cursor:pointer; }
  button.secondary { background:#fff; color:#1a1a1a; }
  button.danger { border-color:#c00; background:#c00; color:#fff; }
  .toggle { padding:4px 10px; font-size:13px; }
  label.field { display:block; margin:12px 0; }
  label.field span { display:block; font-weight:600; margin-bottom:4px; }
  input, select { font:inherit; padding:8px; width:100%; border:1px solid var(--line); border-radius:6px; }
  .notice { background:#fff8e1; border:1px solid #f0d000; padding:12px 16px; border-radius:8px; margin-bottom:16px; }
  .result { padding:10px 16px; border-radius:6px; margin:8px 0; }
  .result.sent { background:#e8f7ee; } .result.error { background:#fde8e8; } .result.skipped { background:#eee; }
  .muted { color:var(--muted); }
  .row { display:flex; gap:8px; align-items:flex-end; }
  .row input { flex:1; }
`;

export function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} — Kindle Digest</title>
<script src="/vendor/htmx.min.js"></script>
<style>${STYLE}</style>
</head><body>
<header>
  <strong>Kindle Digest</strong>
  <nav>
    <a href="/">Dashboard</a>
    <a href="/feeds">Feeds</a>
    <a href="/settings">Settings</a>
  </nav>
</header>
<main>${body}</main>
</body></html>`;
}

export function noFeedsPrompt(error?: string): string {
  const msg = error
    ? `<div class="notice">${escapeHtml(error)}</div>`
    : `<div class="notice">No feeds added yet. Go to <a href="/feeds">Feeds</a> to add your first RSS feed.</div>`;
  return msg;
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
  cadence: 'daily' | 'weekly';
  articles: { article: NormalizedArticle; included: boolean }[];
}

export function dashboard(date: string, folders: DashboardFolder[]): string {
  if (folders.length === 0) {
    return `<p class="muted">No unread articles right now. <a href="/feeds/refresh">Refresh feeds</a> or add more in <a href="/feeds">Feeds</a>.</p>`;
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
      const windowLabel = f.cadence === 'weekly' ? 'last 7 days' : 'last 24h';
      return `<section class="folder">
      <h2 style="flex-wrap:wrap; gap:8px">
        <span style="flex:1">${escapeHtml(f.folder)} <span class="muted">(${includedCount}/${f.articles.length} · ${windowLabel})</span></span>
        <button hx-post="/send/${encodeURIComponent(f.folder)}" hx-target="#send-result" hx-swap="innerHTML">Send now</button>
        <form hx-post="/send/${encodeURIComponent(f.folder)}" hx-target="#send-result" hx-swap="innerHTML" style="display:flex;gap:4px;align-items:center">
          <input type="date" name="date" style="font:inherit;padding:4px 6px;border:1px solid var(--line);border-radius:6px;font-size:13px" required />
          <button type="submit" class="secondary" style="padding:4px 8px;font-size:13px">Send date</button>
        </form>
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

const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function feedsPage(feeds: Feed[], folderSettingsMap: Map<string, FolderSettings>): string {
  const byFolder = new Map<string, Feed[]>();
  for (const f of feeds) {
    if (!byFolder.has(f.folder)) byFolder.set(f.folder, []);
    byFolder.get(f.folder)!.push(f);
  }

  // Sorted folder list used by datalist and move-feed selects.
  const knownFolders = [...byFolder.keys()].sort((a, b) => a.localeCompare(b));

  const folderSections = [...byFolder.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([folder, folderFeeds]) => {
      const fs: FolderSettings = folderSettingsMap.get(folder) ?? {
        folder,
        cadence: 'daily',
        deliveryDay: 0,
      };

      const renameForm = `<form method="post" action="/feeds/${encodeURIComponent(folder)}/rename" style="display:flex; gap:6px; align-items:center; font-size:13px">
        <input name="newName" type="text" value="${escapeHtml(folder)}" required style="width:auto; padding:4px 6px" />
        <button type="submit" class="secondary" style="padding:4px 8px">Rename</button>
      </form>`;

      const cadenceForm = `<form method="post" action="/feeds/${encodeURIComponent(folder)}/cadence" style="display:flex; gap:6px; align-items:center; font-size:13px; flex-wrap:wrap">
        <select name="cadence" onchange="this.form.querySelector('.day-sel').style.display=this.value==='weekly'?'':'none'">
          <option value="daily"${fs.cadence === 'daily' ? ' selected' : ''}>Daily</option>
          <option value="weekly"${fs.cadence === 'weekly' ? ' selected' : ''}>Weekly</option>
        </select>
        <select name="deliveryDay" class="day-sel" style="${fs.cadence !== 'weekly' ? 'display:none' : ''}">
          ${DOW_NAMES.map((d, i) => `<option value="${i}"${fs.deliveryDay === i ? ' selected' : ''}>${escapeHtml(d)}</option>`).join('')}
        </select>
        <button type="submit" class="secondary" style="padding:4px 8px">Save</button>
      </form>`;

      const otherFolders = knownFolders.filter((fn) => fn !== folder);
      const folderOptHtml = otherFolders
        .map((fn) => `<option value="${escapeHtml(fn)}">${escapeHtml(fn)}</option>`)
        .join('');

      const rows = folderFeeds
        .map((f) => {
          const status = f.lastError
            ? `<span class="feed-status error">Error: ${escapeHtml(f.lastError)}</span>`
            : f.lastFetchedAt
              ? `<span class="feed-status">Last fetched ${new Date(f.lastFetchedAt).toLocaleString()}</span>`
              : `<span class="feed-status">Not yet fetched</span>`;
          const nfId = `new-folder-${f.id}`;
          const selId = `move-sel-${f.id}`;
          const moveForm = `<form method="post" action="/feeds/${f.id}/move" style="display:flex; gap:4px; align-items:center">
              <select id="${selId}" name="folder" style="padding:4px 6px; font-size:13px; width:auto"
                onchange="var i=document.getElementById('${escapeHtml(nfId)}');i.style.display=this.value==='__new__'?'':'none';if(this.value!=='__new__')i.removeAttribute('required');else i.setAttribute('required','required')">
                ${folderOptHtml}
                <option value="__new__">New folder…</option>
              </select>
              <input id="${escapeHtml(nfId)}" name="folder" type="text" placeholder="Folder name"
                style="display:none; padding:4px 6px; font-size:13px; width:120px"
                oninput="document.getElementById('${selId}').removeAttribute('name')" />
              <button type="submit" class="secondary" style="padding:4px 8px; font-size:13px">Move</button>
            </form>`;
          return `<div class="feed-row">
            <div class="meta">
              <div class="feed-title">${escapeHtml(f.title || f.url)}</div>
              <div class="feed-url">${escapeHtml(f.url)}</div>
              ${status}
            </div>
            ${moveForm}
            <form method="post" action="/feeds/${f.id}/delete" style="display:inline">
              <button class="danger" type="submit" onclick="return confirm('Delete this feed and its articles?')">Delete</button>
            </form>
          </div>`;
        })
        .join('\n');
      return `<section class="folder">
        <h2 style="flex-wrap:wrap; gap:8px">${escapeHtml(folder)}${renameForm}${cadenceForm}</h2>
        ${rows}
      </section>`;
    })
    .join('\n');

  const emptyMsg = feeds.length === 0 ? `<p class="muted">No feeds yet. Add one below.</p>` : '';

  // knownFolders is declared above, before folderSections.
  const folderOptions = knownFolders.map((f) => `<option value="${escapeHtml(f)}">`).join('');

  return `<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
    <h1 style="margin:0">Feeds (${feeds.length})</h1>
    <form method="post" action="/feeds/refresh">
      <button type="submit" class="secondary">Refresh all</button>
    </form>
  </div>
  ${emptyMsg}
  ${folderSections}
  <datalist id="folders">${folderOptions}</datalist>
  <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:24px">
    <section class="folder">
      <h2>Add feed</h2>
      <div style="padding:16px">
        <form method="post" action="/feeds/add">
          <label class="field"><span>Feed URL (RSS or Atom)</span>
            <input name="url" type="url" placeholder="https://example.com/feed.xml" required /></label>
          <label class="field"><span>Folder</span>
            <input name="folder" list="folders" placeholder="Tech" value="Uncategorized" /></label>
          <button type="submit">Add feed</button>
        </form>
      </div>
    </section>
    <section class="folder">
      <h2>Import OPML</h2>
      <div style="padding:16px">
        <p class="muted" style="margin-top:0">Export your subscriptions from any feed reader (Inoreader, Feedly, etc.) and upload the .opml file. Folders are preserved.</p>
        <form method="post" action="/feeds/import" enctype="multipart/form-data">
          <label class="field"><span>OPML file</span>
            <input name="opml" type="file" accept=".opml,.xml" required /></label>
          <button type="submit">Import</button>
        </form>
      </div>
    </section>
  </div>`;
}

export function settingsPage(s: EffectiveSettings, timezones: string[]): string {
  const tzOptions = timezones
    .map(
      (tz) => `<option value="${escapeHtml(tz)}"${tz === s.timezone ? ' selected' : ''}>${escapeHtml(tz)}</option>`,
    )
    .join('');
  return `<h1>Settings</h1>
  <div class="notice"><strong>Kindle whitelist required.</strong> Add your SMTP <em>from</em> address
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
  </form>`;
}
