# CLAUDE.md

Guidance for Claude Code (and humans) working in this repository.

## Project overview

**kindle-digest** is a single-user web app that turns unread RSS articles
into daily Kindle digests. It:

1. Manages its own list of RSS/Atom feeds in SQLite (add/delete via UI or
   OPML import). Feeds are refreshed hourly in the background.
2. Lets the user **curate** which articles go into today's digest via a
   dashboard (per-article include/exclude).
3. Generates **one EPUB per folder** — each with a designed cover, full
   article text, a per-article QR code linking to the source, and a
   diagnostics page.
4. Emails each EPUB to a Kindle `@kindle.com` address (Amazon Send to
   Kindle), on a daily schedule and on demand.
5. Marks sent articles **read** in the local DB.

Single user — **no authentication**. No external RSS reader dependency.
Reading happens on the Kindle, not in the browser.

## Tech stack (with rationale)

| Concern        | Choice                              | Why |
|----------------|-------------------------------------|-----|
| Runtime        | Node.js 22 + TypeScript             | Readability.js & Sharp are first-class Node libs; one language end-to-end. |
| Web server     | Fastify + HTMX (server-rendered HTML) | Lightweight UI; no SPA build step. Views are plain TS template functions in `src/web/views.ts`. HTMX vendored locally from `node_modules` (no CDN). |
| Database       | better-sqlite3                      | Single-file, synchronous, zero-ops; lives on Fly volume. |
| RSS fetching   | rss-parser                          | Handles RSS 2.0, Atom, and `content:encoded` full-body fields. |
| OPML import    | jsdom (XML mode)                    | Parse feed-reader exports; preserves folder structure. |
| Extraction     | @mozilla/readability + jsdom        | Full-text fallback when feed content is too short. |
| Images         | sharp                               | **Server-side** grayscale/resize (CSS `filter:grayscale` is unreliable on Kindle). |
| QR codes       | qrcode                              | Per-article source links, ≥200×200 for e-ink. |
| EPUB           | custom writer over jszip            | Full control of OPF series metadata, spine order, embedded fonts, cover XHTML. |
| Time/scheduler | luxon                               | Timezone-correct daily delivery + hourly feed refresh. |
| Email          | nodemailer                          | SMTP delivery to Kindle. |
| Tests          | vitest                              | Core-logic tests; no mocked HTTP needed (reader backed by in-memory SQLite). |
| Hosting        | Fly.io (Docker + volume)            | Always-on container for the scheduler + persistent disk for SQLite; low solo-dev ops. |

## Folder structure

```
src/
  config/        env loading, settings accessor
  db/            sqlite schema + migrations + repositories
                   schema.ts      — feeds + articles + selection + run_log tables
                   repositories.ts — settings, selection, run log repos
                   feedRepos.ts   — FeedRepo + ArticleRepo
  reader/        app-facing types (NormalizedArticle) + ReaderClient (SQLite-backed)
  rss/           fetcher.ts (fetch + parse feeds), opml.ts (OPML import parser)
  content/       extract (Readability), images (sharp), qr (qrcode)
  cover/         hash, 4 template renderers, render entry
  epub/          writer (jszip), opf, nav, css
  diagnostics/   diagnostics page builder
  digest/        orchestrator: grouping + build + send per folder
  mail/          nodemailer transport
  scheduler/     daily delivery scheduler (setTimeout-based, tz-aware)
  app/           context (DI), settings resolution
  web/           fastify server (server.ts) + views.ts (HTML template fns)
  index.ts       entry: start web server + scheduler + hourly feed refresh
scripts/fetch-fonts.ts   download Google Fonts woff2 into assets/fonts/
scripts/smoke-epub.ts    end-to-end EPUB build + structure validation
assets/fonts/            embedded woff2 (committed)
test/                    vitest specs
```

## Coding conventions

- TypeScript, ES modules, `strict` on. Prefer named exports.
- Pure, testable core logic; side effects (HTTP, fs, SMTP) isolated at edges.
- No secrets in code or logs. Never log SMTP credentials.
- Keep functions small; transformations should be unit-testable without I/O.
- Match Prettier config (single quotes, semicolons, width 100).

## Key commands

| Command              | What it does |
|----------------------|--------------|
| `npm install`        | Installs deps (builds native sharp/better-sqlite3). |
| `npm run fetch-fonts`| Downloads required Google Fonts as woff2 into `assets/fonts/`. |
| `npm run dev`        | Dev server (tsx watch) + scheduler + feed refresh. |
| `npm run build`      | `tsc` → `dist/`. |
| `npm start`          | Runs built app. |
| `npm test`           | Vitest (core logic). |
| `npm run lint`       | ESLint. |
| `npm run typecheck`  | `tsc --noEmit`. |
| Deploy               | `fly deploy` (uses `Dockerfile` + `fly.toml`; volume holds the DB). |

## Feed management

Feeds are managed entirely within the app — no external RSS reader needed.

- **Add feed:** `/feeds` → paste an RSS/Atom URL + assign a folder name.
- **OPML import:** `/feeds` → upload a `.opml` file. Folder structure is
  preserved. Inoreader export: *Preferences → Subscriptions → Export OPML*.
- **Refresh:** Feeds are fetched on startup (5 s delay) and every hour via
  `setInterval`. Manual refresh available via the Refresh all button.
- **Article retention:** Read articles older than 30 days are pruned on
  each refresh cycle.

## Full-text detection

`src/content/fulltext.ts` — `contentIsFull(article, minChars)` compares
the visible-text length of the feed's `content:encoded` (or `content`)
field against `FULLTEXT_MIN_CHARS` (default 1800). If the feed provides
full content, the Readability fetch is skipped. Tune this threshold per
your feeds.

## Known constraints & gotchas

- **Kindle sender whitelist:** the SMTP `from` address MUST be added to
  Amazon's *Approved Personal Document E-mail List*, or delivery is silently
  dropped. Surfaced prominently in the README — keep it there.
- **Format:** Currently emitting `.mobi` (renamed EPUB bytes) to verify Amazon rejection behaviour. Switch back to `.epub` + `application/epub+zip` after testing.
- **Full text is always required.** Never fall back to a truncated excerpt.
  If extraction fails (paywall / JS-rendered / HTTP error), include the
  article with an inline error notice — never silently drop it.
- **Grayscale server-side** via sharp. Do not rely on CSS `filter:grayscale`.
- **Self-contained EPUBs.** Fonts embedded as woff2 in `fonts/` with
  `@font-face`; no external CDN links anywhere in the EPUB.
- **Series metadata:** series name = folder name; series index = ISO date
  string (e.g. `2025-01-15`). Drives Kindle collection grouping.
- **Cover hash is stable** (djb2-xor, see `src/cover/hash.ts`) — a folder's
  template/glyph must never change day-to-day.
- **Kindle series via EPUB3 `belongs-to-collection`**; ISO date is
  non-numeric as `group-position`, so we also write calibre series meta.
  Verify grouping in Kindle Previewer.
- **OPML nesting:** only two levels are common (folder → feed). Deeper nesting
  is flattened to the nearest named parent folder.

## Current status

- **2026-06-08** — V2: replaced Inoreader dependency with self-hosted RSS.
  App now manages its own feed list + read state in SQLite. Added:
  `src/reader/` (ReaderClient over SQLite), `src/rss/` (rss-parser fetcher +
  OPML import), `src/db/feedRepos.ts` (FeedRepo + ArticleRepo), `/feeds` UI
  (add/delete/refresh/OPML upload), hourly feed refresh scheduler.
  `@fastify/multipart` added for OPML file upload. No external service
  dependencies beyond SMTP.
  - **Next / not yet done:** live SMTP send test; confirm Kindle series
    grouping in Kindle Previewer; tune `FULLTEXT_MIN_CHARS` against real feeds;
    optional in-article image embedding.
  - Update this section at the start of every session.
