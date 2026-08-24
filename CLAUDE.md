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
scripts/fetch-fonts.ts   download Google Fonts (woff2 + ttf) into assets/fonts/
scripts/smoke-epub.ts    end-to-end EPUB build + structure validation
assets/fonts/            woff2 (EPUB) + ttf (fontconfig/metrics), committed
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
| `npm run fetch-fonts`| Downloads required Google Fonts (woff2 + ttf) into `assets/fonts/`. Skips files already present. |
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
  reliably apply flexbox/gradients.
- **librsvg ignores `@font-face`. Cover fonts must go through fontconfig.**
  sharp rasterizes the cover overlay via libvips → librsvg, which resolves
  families through fontconfig only and silently drops webfonts embedded as
  `src:url('data:font/woff2;base64,...')`. The cover did exactly that until
  2026-08-24, so every cover rendered in Liberation/DejaVu instead of its
  designed face. `src/cover/fontconfig.ts` now writes a generated `fonts.conf`
  pointing at `assets/fonts` and exports `FONTCONFIG_FILE`; it runs as an
  **import side effect** because fontconfig reads its config once, at first
  use — setting the variable after anything has rendered text is ignored.
  Two consequences worth remembering:
  - `assets/fonts/` holds **both** formats. The woff2 is what the EPUB
    embeds; the **ttf** is what fontconfig indexes and what `opentype.js`
    reads metrics from (it cannot parse woff2). `FONT_FACES` names both.
  - Google's static exports of a *variable* font carry the default instance's
    name, so all three Bricolage weights self-report as `Bricolage Grotesque
    96pt ExtraBold`. `FontFace.fcFamily` records that and the generated config
    aliases the design name onto it. Check `fc-query` before adding a family.
- **Title sizing measures the font, it does not estimate.** `src/cover/fontMetrics.ts`
  sums real advance widths for the same family+weight+style librsvg will
  resolve. The previous `characters × size × ratio` estimate was calibrated
  against fonts that never rendered and was wrong both ways: The Signal
  overflowed the 944 px budget (977 px at the size it chose — the clipped
  cover), while The Drop's condensed Bebas was over-measured by ~1.8× and
  shrank titles that had room. Measuring the wrong style is a bigger error
  than the estimate was — an upright measured for an italic is ~14% off.
- **Dual Kindle grouping mechanisms present at once:** the OPF sets both
  `<dc:type>magazine</dc:type>` + a `<guide>` (periodical navigation) *and*
  `belongs-to-collection` series metadata. These come from two different
  iteration attempts (periodical/Calibre-recipe vs. series/collection) and
  their interaction on-device hasn't been re-confirmed since being combined.
- **OPML nesting:** only two levels are common (folder → feed). Deeper nesting
  is flattened to the nearest named parent folder.

## Delivery (durable outbox)

Delivery is a persisted state machine, not an in-flight promise. The `delivery`
table (`src/db/schema.ts`) holds one row per `(digest_date, folder)`, unique —
which is the idempotency key that makes double-clicks, duplicate timers and the
startup catch-up all safe.

```
pending ──claim──> building ──ok──> built ──claim──> sending ──accepted──> sent
   ^                  │               ^                 │
   └──── backoff ─────┴───────────────┴─────────────────┘   attempts++
                                                            exhausted → failed → alert
```

- `src/delivery/worker.ts` drains it one row at a time (serial by design — that
  is what bounds memory). `src/delivery/backoff.ts` is the pure retry schedule.
- The scheduler (`src/scheduler/runner.ts`) only *enqueues*; it can no longer
  hang or OOM, always re-arms in a `finally`, and `catchUp()` on boot queues a
  slot missed while the machine was down.
- A retry from `built` **re-sends without rebuilding** — the EPUB is already on
  the volume at `DIGEST_DIR`.
- `run_log.status` means **build** state (`running|built|error`), never
  delivery. `delivery.state` is the only authority on whether mail was accepted,
  and `sent` is written only after SMTP returns a `messageId`.
- Failures email `ALERT_EMAIL` once (`alerted_at` guard). That alert rides the
  same SMTP path that may be broken, so the outbox row — not the email — is the
  record.

## Build profile: memory and speed

Measured with `scripts/bench-digest.ts`. **Pass `--latency <ms>`** — without it
the stub fetchers return instantly, which measures CPU only and hides the fact
that a real build is dominated by network waits. Figures below use
`--latency 300`, peak RSS on a 512 MB VM, ±13 MB run-to-run:

| articles | original | now (concurrency 4 + jemalloc) |
|----------|----------|-------------------------------|
| 40       | 245 MB / 15.6 s | 313 MB /  4.8 s |
| 157      | 320 MB / 58.3 s | 345 MB / 15.8 s |
| 320      | 443 MB / 117.8 s | 342 MB / 31.0 s |

**Peak RSS no longer scales with article count.** It is now a function of
concurrency (a fixed working set of in-flight articles), not of digest length —
a 320-article build peaks about where a 40-article one does. Small digests cost
slightly more than before because 4 articles are in flight instead of 1; that is
the intended trade.

Concurrency is the knob, via `BUILD_CONCURRENCY` (default 4). At 320 articles:

| concurrency | wall clock | peak RSS |
|-------------|-----------|----------|
| 1  | 117.6 s | 292 MB |
| 2  |  59.8 s | 298 MB |
| 4  |  31.0 s | 342 MB |
| 8  |  20.5 s | 398 MB |
| 16 |  15.1 s | 446 MB |

Diminishing returns past 8, and the ceiling is 512 MB — lower it if a folder
grows much busier or real digests run heavier than the synthetic profile.

### Reading real build cost (no terminal needed)

Every EPUB's diagnostics page reports peak RSS against the 512 MB VM, the
`BUILD_CONCURRENCY` behind it, build time and image count — so a real digest
measures itself on real feeds with real distinct images, which no synthetic
benchmark can. Grab a book from the dashboard's Download button and read the
last page; the complete peak (including zip) is in `run_log` and rides along in
failure-alert emails.

The page's figure is taken before `buildEpubToFile`, so it excludes final
assembly — ~30 MB short of the true peak at 320 articles. That is deliberate:
diagnostics is generated before the zip exists. Do not "fix" it by moving the
diagnostics build later; it is the last spine item and must be written first.

Deploys run from GitHub Actions (**Actions → Deploy to Fly → Run workflow**),
`workflow_dispatch` only. Needs a `FLY_API_TOKEN` repo secret — see README.

### Verifying against real data

Every figure above is **synthetic**. `--db` alone does not fix that: it reads
real article content from SQLite but still stubs the network, serving the *same*
image to every article — which lets libvips' cache hit in a way it never can on
real feeds. Only `--real-fetch` measures real per-article image churn.

On the Fly machine (deploy first, or this measures the old pipeline):

```
fly deploy --app kindle-digest
fly ssh console --app kindle-digest
cd /app && npx tsx scripts/bench-digest.ts --db /data/kindle-digest.sqlite \
  --folder News --date 2026-08-23 --real-fetch --concurrency 1
```

**Step `--concurrency` up from 1** — a build peak on top of the running app can
OOM a 512 MB VM. The benchmark only builds; it never sends mail or marks
articles read, so it cannot disturb delivery state. If real peaks come in above
the synthetic profile, lower the default without a redeploy:
`fly secrets set BUILD_CONCURRENCY=2 --app kindle-digest`.

### What actually mattered

Found by `DIGEST_TRACE=1`, which logs RSS/heap at each phase boundary. Worth
reaching for first: this pipeline's memory behaviour has defied inspection more
than once, and peak RSS alone says nothing about *which* phase caused it.

1. **Fusing the resolve and render loops (the big one, 490 → 363 MB).** The
   build used to resolve every article, then loop again to render and stage.
   That held all 320 sanitized bodies in the heap simultaneously — measured at
   **253 MB of heapUsed** at the phase boundary. Releasing them in the second
   loop was one full phase too late. The loops are now fused: resolve, render,
   stage, release, one article at a time. Feed ordering and cover-image
   candidates are computed from feed metadata up front, which is what made the
   two loops separable in the first place.
2. **jemalloc** (`LD_PRELOAD` in the Dockerfile) — ~40 MB at concurrency 4, more
   at higher concurrency. sharp/libvips churn large short-lived buffers and
   glibc keeps the freed chunks; this supersedes `MALLOC_ARENA_MAX=2`.
3. **`sharp.cache(false)` + `sharp.concurrency()`** (`src/content/sharpConfig.ts`)
   — no measurable effect on the synthetic benchmark, which reuses one image for
   every fetch so libvips' cache genuinely hits. Kept because real feeds serve
   all-distinct images, where a 50 MB cache can never hit and is pure cost.
   **Unverified against real data** — do not credit it without a `--db` run.

The EPUB itself is ~0.9 MB for 320 articles. Output size and build memory are
unrelated: the memory goes on raw decoded pixels and DOM trees that exist only
before compression. A 3000×2000 source image is ~18 MB decoded and lands in the
book at ~40 KB.

## Current status

- **2026-08-24 (latest)** — Fixed the cover fonts. The visible symptom was a
  title clipped off the right edge in a generic sans; the cause was two bugs
  stacked, both pre-existing on `main` and invisible to the test suite.
  - **`@font-face` never worked.** librsvg resolves through fontconfig and
    ignores embedded webfonts, so the base64 face in every cover SVG was inert
    and covers rendered in Liberation/DejaVu. Proven by rendering the same
    string with the face embedded, without it, and under a nonexistent family:
    all three byte-identical (1141×115), while a real installed font gave
    1087×102. Fixed by `src/cover/fontconfig.ts` (generated `fonts.conf` +
    `FONTCONFIG_FILE`, set as an import side effect) and by committing the
    **ttf** twin of each woff2.
  - **The fit maths was calibrated against fonts that never rendered.** Replaced
    `TITLE_WIDTH_RATIO` with real advance widths (`src/cover/fontMetrics.ts`,
    opentype.js). The Signal's "TECHNOLOGY" went 150 px → 142 px (977 px drawn,
    over a 944 px budget → 925 px, inside it); The Drop's over-shrunk titles
    went the other way, 126 px → 230 px. Broadsheet is unchanged at 140 px,
    which is the check that the new measurement agrees where the old estimate
    was already right.
  - **Bricolage needed an alias.** Google's static instances of a variable font
    are named after its default instance, so all three weights self-report as
    `Bricolage Grotesque 96pt ExtraBold`. `FontFace.fcFamily` + a generated
    fontconfig rule. Playfair, Bebas and EB Garamond are clean.
  - **`Dockerfile` now `COPY assets ./assets`.** It previously never copied
    `assets/` and re-downloaded all nine fonts from `gwfh.mranftl.com` on every
    image build — a deploy-time dependency on a third-party host, and a way for
    deployed bytes to drift from committed ones. `fetch-fonts` is now a no-op
    guard in the image.
  - Removed the inert `@font-face` embedding and the now-dead `fonts` parameter
    from `buildCoverSvg`/`buildCoverJpeg` (5–22 KB of base64 per cover that also
    read as though fonts were handled).
  - Tests 121 passing (11 new in `test/cover-fonts.test.ts`, which assert
    against the **raster**: that each family resolves to something other than
    the fallback, and that every title's drawn ink fits the budget). Both fail
    against the old code — verified, not assumed. typecheck + lint clean.
    `smoke-epub.ts` unchanged: same two pre-existing failures, none new.
    Bench 40 articles / 50 ms latency: 2.2 s, 339 MB — no regression.
  - **Why the old tests could not catch this:** `DUMMY_FONTS` was
    `Buffer.from('woff2-bytes')`, 11 bytes and not a parseable font, so every
    cover assertion ran with librsvg unable to load a face and proved only that
    the *string* contained `@font-face`. Any check of cover typography has to
    rasterize.
  - **Next / not yet done:** unchanged from below — the real-data bench run on
    the volume, a real Kindle delivery end-to-end, and the two long-standing
    `smoke-epub.ts` failures. Note the second of those, `cover references font`,
    asserts `url('fonts/` against a cover XHTML that has been a bare `<img>`
    wrapper since covers were rasterized; it is a stale assertion, not a
    regression, and this work did not address it.

- **2026-08-24 (later)** — Cut build memory *and* wall-clock, after the question
  "320 articles should still make an EPUB smaller than 10 MB — what's using the
  memory?" The premise was right and exposed two things.
  - **The benchmark was blind to the dominant cost.** `bench-digest.ts` stubbed
    `fetchPage`/`fetchImage` with zero delay, so "157 articles in 14 s" was
    CPU-only. A real build is mostly network wait. Added `--latency`; the same
    320-article build then measured 117.8 s, nearly all of it idle.
  - **The real memory hog was loop structure, not sharp.** `DIGEST_TRACE=1`
    showed heapUsed hitting 253 MB at the resolve/render boundary — every
    article's sanitized body live at once. Fusing the loops took 320 articles
    from 490 → 363 MB. See "Build profile" above.
  - Added bounded concurrency (`src/util/concurrency.ts`, `BUILD_CONCURRENCY`,
    default 4): 320 articles now build in 31 s instead of 117.6 s, at a peak
    *below* the original. Order is preserved by index, not completion —
    `test/orchestrator-order.test.ts` asserts the book is byte-identical at
    concurrency 1 and 8.
  - jemalloc replaces `MALLOC_ARENA_MAX=2` in the Dockerfile.
  - Tests 96 passing (8 new). typecheck + lint clean. `smoke-epub.ts` unchanged:
    same two pre-existing failures, no new ones.
  - **Two hypotheses of mine measured as wrong** and are recorded as such rather
    than quietly dropped: the 50 MB libvips cache (no effect on the synthetic
    benchmark) and hoisting the `PAYWALL_HINTS` check in `extract.ts` (rejected
    before implementing — it would have run `toLowerCase()` on a ~1 MB string
    for every article to reclaim ~1 MB against a ~15 MB DOM).
  - **Next / not yet done:** all figures are synthetic. The real-data run still
    needs the volume:
    `npx tsx scripts/bench-digest.ts --db /data/kindle-digest.sqlite --folder News --date 2026-08-23 --latency 0`.
    Real feeds serve distinct images per article, so expect higher peaks than the
    synthetic profile — if it runs hot, lower `BUILD_CONCURRENCY` to 2 (≈45 MB
    cheaper, half the speed). Still open from before: confirm a real Kindle
    delivery end-to-end; the two `smoke-epub.ts` failures.

- **2026-08-24** — Rebuilt delivery around a durable outbox after five digests
  silently failed to send. Root causes found: `run_log` hardcoded `status='sent'`
  at the *end of the build*, before mail was attempted, and `finish(…,'error',…)`
  had no call site — so `error` was NULL in every row ever written and a failed
  send was indistinguishable from a delivered one. Alongside that: no retry or
  persistence of "needs sending", `void this.fire()` with no `.catch()` (one
  throw stopped delivery permanently), no catch-up for a missed slot, and
  discarded SMTP results.
  - Added `delivery` table + `DeliveryRepo` + `DeliveryWorker`; scheduler is now
    enqueue-only; send routes queue and return instead of blocking the request.
  - SMTP: explicit timeouts, `info.accepted`/`rejected` inspected, transport
    closed, transient vs permanent classification so a bad password fails fast.
  - Memory: article pages and images staged to disk; JS heap now flat with
    article count (see table above). 157-article weekly digest builds in ~14 s
    at ~316 MB peak.
  - Tests 88 passing (29 new: backoff, outbox state machine, SMTP classify).
    typecheck + lint clean — the old `no-irregular-whitespace` error in
    `sanitize.ts` is fixed too.
  - **Note:** the jsdom-leak theory turned out to be wrong — closing windows
    made no measurable difference (heap was flat; the growth was retained
    XHTML strings). The `close()` calls were kept as correctness hygiene, but
    do not credit them with the fix.
  - **Next / not yet done:** verify against the real 2026-08-23 news digest on
    the volume (`bench-digest.ts --db /data/kindle-digest.sqlite --folder News
    --date 2026-08-23`); confirm a real Kindle delivery end-to-end; the two
    long-standing `smoke-epub.ts` failures (numeric `group-position`, cover font
    reference) are still open and predate this work.

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
