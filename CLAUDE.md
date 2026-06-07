# CLAUDE.md

Guidance for Claude Code (and humans) working in this repository.

## Project overview

**kindle-digest** is a single-user web app that turns unread Inoreader
articles into daily Kindle digests. It:

1. Pulls unread articles from **Inoreader** (the source of truth for feeds
   and read state), grouped by **top-level folder**.
2. Lets the user **curate** which articles go into today's digest via a
   dashboard (per-article include/exclude).
3. Generates **one EPUB per folder** — each with a designed cover, full
   article text, a per-article QR code linking to the source, and a
   diagnostics page.
4. Emails each EPUB to a Kindle `@kindle.com` address (Amazon Send to
   Kindle), on a daily schedule and on demand.
5. Marks sent articles **read in Inoreader** (propagates to Reeder, etc.).

Single user — **no authentication**. Reading happens on the Kindle, not in
the browser.

## Tech stack (with rationale)

| Concern        | Choice                              | Why |
|----------------|-------------------------------------|-----|
| Runtime        | Node.js 22 + TypeScript             | Readability.js & Sharp are first-class Node libs; one language end-to-end. |
| Web server     | Fastify + HTMX (server-rendered HTML) | Lightweight UI; no SPA build step. Views are plain TS template functions in `src/web/views.ts`. HTMX vendored locally from `node_modules` (no CDN). |
| Database       | better-sqlite3                      | Single-file, synchronous, zero-ops; lives on Fly volume. |
| Inoreader      | undici + custom OAuth2 client       | Google-Reader-compatible API; auth-code flow with token refresh. |
| Extraction     | @mozilla/readability + jsdom        | Spec-mandated full-text fallback. |
| Images         | sharp                               | **Server-side** grayscale/resize (CSS `filter:grayscale` is unreliable on Kindle). |
| QR codes       | qrcode                              | Per-article source links, ≥200×200 for e-ink. |
| EPUB           | custom writer over jszip            | Full control of OPF series metadata, spine order, embedded fonts, cover XHTML. |
| Time/scheduler | luxon + node-cron                   | Timezone-correct daily delivery. |
| Email          | nodemailer                          | SMTP delivery to Kindle. |
| Secrets        | dotenv + AES-256-GCM                 | OAuth tokens encrypted at rest; never hardcoded. |
| Tests          | vitest + nock                       | Core-logic + mocked HTTP. |
| Hosting        | Fly.io (Docker + volume)            | Always-on container for the scheduler + persistent disk for SQLite/tokens; low solo-dev ops. |

## Folder structure

```
src/
  config/        env loading, settings accessor, token encryption (AES-256-GCM)
  db/            sqlite schema + migrations + repositories
  inoreader/     oauth, client, types (folders, unread, edit-tag)
  content/       extract (Readability), images (sharp), qr (qrcode)
  cover/         hash, 4 template renderers, render entry
  epub/          writer (jszip), opf, nav, css
  diagnostics/   diagnostics page builder
  digest/        orchestrator: grouping + build + send per folder
  mail/          nodemailer transport
  scheduler/     cron (luxon tz -> daily trigger)
  app/           context (DI), settings resolution
  web/           fastify server (server.ts) + views.ts (HTML template fns)
  index.ts       entry: start web server + scheduler
scripts/fetch-fonts.ts   download Google Fonts woff2 into assets/fonts/
scripts/smoke-epub.ts    end-to-end EPUB build + structure validation
assets/fonts/            embedded woff2 (committed)
test/                    vitest specs
```

## Coding conventions

- TypeScript, ES modules, `strict` on. Prefer named exports.
- Pure, testable core logic; side effects (HTTP, fs, SMTP) isolated at edges.
- No secrets in code or logs. Never log OAuth tokens or full SMTP creds.
- Keep functions small; transformations should be unit-testable without I/O.
- Match Prettier config (single quotes, semicolons, width 100).

## Key commands

| Command              | What it does |
|----------------------|--------------|
| `npm install`        | Installs deps (builds native sharp/better-sqlite3). |
| `npm run fetch-fonts`| Downloads required Google Fonts as woff2 into `assets/fonts/`. |
| `npm run dev`        | Dev server (tsx watch) + scheduler. |
| `npm run build`      | `tsc` → `dist/`. |
| `npm start`          | Runs built app. |
| `npm test`           | Vitest (core logic). |
| `npm run lint`       | ESLint. |
| `npm run typecheck`  | `tsc --noEmit`. |
| Deploy               | `fly deploy` (uses `Dockerfile` + `fly.toml`; volume holds the DB). |

## Known constraints & gotchas

- **Kindle sender whitelist:** the SMTP `from` address MUST be added to
  Amazon's *Approved Personal Document E-mail List*, or delivery is silently
  dropped. Surfaced prominently in the README — keep it there.
- **EPUB only.** Amazon deprecated MOBI for Send to Kindle (2022). Never emit MOBI.
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
- **Inoreader "full content" is a heuristic** (text-length threshold,
  `FULLTEXT_MIN_CHARS`). Verify field shapes against the live API and tune.
- **Kindle series via EPUB3 `belongs-to-collection`**; ISO date is
  non-numeric as `group-position`, so we also write calibre series meta.
  Verify grouping in Kindle Previewer.

## Current status

- **2026-06-07** — V1 implemented end-to-end. Stack approved (Node/TS, Fly.io,
  Fastify+HTMX). Done: config/crypto, SQLite repos, Inoreader OAuth + client,
  full-text detection + Readability fallback, sharp grayscale + QR, 4-template
  cover system + font download/embed, custom EPUB writer (series metadata,
  spine order), diagnostics page, orchestrator, scheduler, web UI (dashboard /
  toggle / send / settings / OAuth), Dockerfile + fly.toml + README.
  Tests: 57 passing (hash, cover render, client + fallback, extraction, QR,
  EPUB, grouping, diagnostics, schedule, crypto, images, font loader). Smoke:
  `scripts/smoke-epub.ts` builds a valid 134 KB EPUB.
  - **Next / not yet done:** live Inoreader API verification (tune
    `FULLTEXT_MIN_CHARS` + confirm field shapes); confirm Kindle series
    grouping in Kindle Previewer; optional in-article image embedding; real
    SMTP send test.
  - Update this section at the start of every session.
