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
| EPUB           | custom writer over jszip            | Full control of OPF series/periodical metadata, spine order, embedded fonts, NCX + guide for Kindle stacking. |
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
  cover/         hash, 4 template configs, sharp-composited raster render (composite.ts)
  epub/          writer (jszip), opf, nav, toc, ncx, masthead, sectionIndex, css
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
- **Per-folder settings** (`/feeds/:folder/cadence`, `/feeds/:folder/cover`):
  cadence (`daily` | `weekly` + delivery day), and an optional cover
  template/theme override (else auto-assigned by folder-name hash).
- **Folder management:** rename a folder or move a feed between folders
  from `/feeds`.
- **Dashboard date picker:** the dashboard can view/curate/send a past date's
  digest, not just today's (`?date=YYYY-MM-DD`); article lists collapse by
  default under each folder header.
- **Download without email:** `/download/:folder` and `/download-all` (zip of
  every folder's EPUB) let you grab the generated files directly, no SMTP
  round-trip needed — useful for testing the pipeline without Kindle delivery.

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
- **EPUB only.** Amazon deprecated MOBI for Send to Kindle (2022). Never emit MOBI.
- **Full text is always required.** Never fall back to a truncated excerpt.
  If extraction fails (paywall / JS-rendered / HTTP error), include the
  article with an inline error notice — never silently drop it.
- **Grayscale server-side** via sharp. Do not rely on CSS `filter:grayscale`.
- **Self-contained EPUBs.** Fonts embedded as woff2 in `fonts/` with
  `@font-face`; no external CDN links anywhere in the EPUB.
- **Series metadata:** series name = folder name; series index is currently
  written as the plain ISO date string (e.g. `2026-06-07`) via
  `belongs-to-collection` + calibre `calibre:series_index` (`src/epub/opf.ts`,
  set in `src/digest/orchestrator.ts`). **Note:** an earlier fix (commit
  `cc1d42f`) found Kindle requires `group-position` to be a *numeric* string
  (used `YYYYMMDD`, e.g. `20260607`) or it silently ignores the series and
  never stacks the books — but that fix was lost when series metadata was
  reworked during the periodical-format detour (`de9793f`) and never
  reapplied. Re-verify in Kindle Previewer before trusting collection
  grouping; if stacking doesn't work, this is the first place to check.
- **Cover hash is stable** (djb2-xor, see `src/cover/hash.ts`) — a folder's
  auto-assigned template/glyph must never change day-to-day. A folder can
  also override its template/theme explicitly via `/feeds/:folder/cover`
  (stored in `folder_settings`, see `src/db/feedRepos.ts`).
- **Covers are rasterized, not CSS.** `src/cover/composite.ts` renders the
  full cover (gradient, text, glyph) as a single JPEG via sharp at
  1072×1448 (Kindle Paperwhite); the EPUB cover XHTML is just a full-bleed
  `<img>` wrapper (`src/cover/render.ts`). This replaced the original
  CSS-in-XHTML template approach because Kindle's e-ink renderer didn't
  reliably apply flexbox/gradients. `test/cover-render.test.ts` still
  asserts against the old CSS-XHTML output and is stale (see Current status).
- **Dual Kindle grouping mechanisms present at once:** the OPF sets both
  `<dc:type>magazine</dc:type>` + a `<guide>` (periodical navigation) *and*
  `belongs-to-collection` series metadata. These come from two different
  iteration attempts (periodical/Calibre-recipe vs. series/collection) and
  their interaction on-device hasn't been re-confirmed since being combined.
- **OPML nesting:** only two levels are common (folder → feed). Deeper nesting
  is flattened to the nearest named parent folder.

## Current status

- **2026-06-10** — This section was stale (last updated 2026-06-08) despite
  ~20 commits of real iteration on top of it — refreshed after a status
  review. Since V2 (self-hosted RSS), the project has been driven mostly by
  live testing against real feeds and an actual Kindle:
  - **Cover system rewritten**: moved from CSS-in-XHTML templates to
    sharp-composited raster JPEGs (`src/cover/composite.ts`, 1072×1448)
    because Kindle's e-ink renderer didn't apply the CSS reliably. Added
    light/dark theme variants and per-folder template/theme overrides.
  - **Output format churn, resolved**: briefly tried MOBI, confirmed Amazon
    rejects it, reverted to EPUB (see commit `1c6cfa9`/`45e2cb3`) — MOBI is
    definitively out, EPUB-only stands.
  - **Kindle stacking iteration**: went EPUB series metadata → Calibre
    recipe/periodical pipeline → rolled back to the custom EPUB builder with
    periodical `<dc:type>` + `<guide>` *and* series `belongs-to-collection`
    both present. See the "dual Kindle grouping mechanisms" gotcha above —
    the numeric `group-position` fix from `cc1d42f` appears to have been
    lost in this churn and should be re-verified.
  - **Feed/folder management grew**: per-folder cadence (daily/weekly),
    folder rename, feed move, retroactive date-scoped dashboard, direct
    EPUB/zip download endpoints alongside email send.
  - **Image extraction hardening**: webcomic/SMBC-style feeds (short body,
    image-only content) needed a raised image-only text threshold (350
    chars) plus a Readability-failure safety net that falls back to feed
    content when an `<img>` is present.
  - Config/crypto (`src/config/crypto.ts`) and `TokenRepo`/`oauth_tokens`
    (`src/db/repositories.ts`) are **dead code** left over from the
    Inoreader-OAuth era (V1) — nothing in `src/app/context.ts` wires them up
    anymore. Safe to delete when convenient; harmless to leave.
  - **Test suite has real drift**: `npm test` currently reports 11/60 failing,
    all in `test/cover-render.test.ts` (asserts the old CSS-XHTML cover
    markup — obsolete now that covers are rasterized) and one bound check in
    `test/images.test.ts` (asserts 1200×900, current cover source is
    1600×2400). These are stale-test debt from the cover rewrite, not
    regressions in app behavior — but they mean `npm test` is not currently a
    reliable signal. Needs a rewrite against `composite.ts`.
  - `npm run lint` has one real error: `src/content/sanitize.ts` intentionally
    matches literal zero-width/soft-hyphen characters in a regex, which
    ESLint's `no-irregular-whitespace` flags. Needs an inline disable comment
    or a switch to `​`-style escapes — not a functional bug.
  - `npm run typecheck` and `npm run build` are clean.
  - **Next / not yet done:** rewrite `test/cover-render.test.ts` +
    `test/images.test.ts` against the current raster cover pipeline;
    re-verify Kindle series/periodical stacking on-device (numeric
    group-position question above); fix the lint error; decide whether to
    delete the dead Inoreader-token code; tune `FULLTEXT_MIN_CHARS` further
    as new feeds are added.
  - Update this section at the start of every session.
