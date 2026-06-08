# kindle-digest

A single-user web app that turns your RSS feeds into **daily Kindle digests**.
It manages its own feed list, lets you curate which articles go into today's
digest, and delivers **one EPUB per folder** — with a designed cover, full
article text, a per-article QR code back to the source, and a diagnostics page
— straight to your Kindle, on a schedule and on demand.

No external RSS reader required. All feeds and read state live in a local
SQLite database on your Fly.io volume.

---

## Required setup: whitelist your sender on Amazon

**Send to Kindle silently drops email from unknown senders.** Before anything
will reach your device you MUST add your sending address to Amazon's approved
list:

1. Go to **Amazon → Manage Your Content and Devices → Preferences →
   Personal Document Settings**.
2. Under **Approved Personal Document E-mail List**, click **Add a new approved
   e-mail address**.
3. Add the exact address you configure as `SMTP_FROM`.
4. Find your Kindle's **Send-to-Kindle e-mail** (`…@kindle.com`) on the same
   page — that goes in the Settings page as your Kindle email.

If digests never arrive, this whitelist step is the first thing to check.

---

## How it works

```
RSS/Atom feeds (fetched hourly) ──► articles grouped by folder
                      │
                  Dashboard (curate: include / exclude per article)
                      │
        ┌─────────────┴───────────────┐
   Full-text fetch                Cover + QR + diagnostics
   (feed content if full enough,  (grayscale image, embedded fonts,
    else Readability.js fallback)  series metadata for Kindle collections)
        └─────────────┬───────────────┘
                 One EPUB per folder
                      │
            SMTP ──► your @kindle.com address
                      │
                Mark articles read in local DB
```

- **Full text is always included.** If extraction fails (paywall, JS-rendered,
  HTTP error) the article is still included with a clear inline notice — never
  dropped, never truncated.
- **Series metadata** sets series name = folder, series index = ISO date, so
  Kindle groups each folder's digests into a browsable collection.
- **Covers** use a four-template design system assigned by a stable hash of the
  folder name (never changes day-to-day). Fonts are embedded in the EPUB.

## Tech stack

Node.js 22 + TypeScript · Fastify + HTMX · better-sqlite3 · rss-parser ·
@mozilla/readability + jsdom · sharp · qrcode · custom EPUB writer (jszip) ·
luxon · nodemailer. Hosting: Fly.io. See [`CLAUDE.md`](./CLAUDE.md) for full
rationale.

---

## Quick start (local)

```bash
git clone <repo> && cd kindle-digest
npm install
npm run fetch-fonts      # downloads + embeds the cover fonts (woff2)

cp .env.example .env     # fill in SMTP vars (all others are optional)
npm run dev              # http://localhost:3000
```

Then in the browser:

1. Go to **Feeds** and add RSS/Atom feed URLs, or upload an **OPML file**
   exported from your existing feed reader (Inoreader: *Preferences →
   Subscriptions → Export OPML*). Feeds are grouped by the folder names you
   assign (or from the OPML structure).
2. Open **Settings**, enter your Kindle email, delivery time, timezone, and
   SMTP details. Save.
3. On the **Dashboard**, toggle articles include/exclude, then **Send now** for
   a folder or **Send all**. The scheduler also delivers daily at your chosen
   time.

### Environment variables

Copy `.env.example` to `.env` and set:

| Variable | Required | Notes |
|----------|----------|-------|
| `APP_BASE_URL` | – | Public base URL (default `http://localhost:3000`). Set to your Fly URL in production. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | – | `SMTP_FROM` must be Amazon-whitelisted. Can also be set in the Settings UI after launch. |
| `KINDLE_EMAIL` | – | Your `…@kindle.com` address. Can also be set in the Settings UI. |
| `DELIVERY_TIME` / `TIMEZONE` | – | Daily send time (HH:mm, 24h) and IANA timezone. Defaults: `06:30` / `America/New_York`. |
| `DATABASE_PATH` | – | SQLite path. On Fly this lives on the mounted volume (`/data/kindle-digest.sqlite`). |
| `FULLTEXT_MIN_CHARS` | – | Min visible-text chars before feed content is treated as "full" (else Readability fallback). Default `1800`. |

No OAuth tokens or encryption keys are required.

---

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Dev server + scheduler (tsx watch). |
| `npm run fetch-fonts` | Download + embed the cover fonts. |
| `npm test` | Run the test suite (core logic). |
| `npm run lint` / `npm run typecheck` | Lint / type-check. |
| `npm run build` && `npm start` | Compile and run production build. |
| `npx tsx scripts/smoke-epub.ts` | Build a sample EPUB to `out/sample.epub` for inspection. |

---

## Deploy to Fly.io

```bash
# 1. Install flyctl and log in
fly auth login

# 2. Create app + persistent volume
fly apps create kindle-digest          # pick a globally-unique name
fly volumes create kindle_digest_data --size 1 --region iad --app kindle-digest

# 3. Set SMTP secrets (or configure via the Settings page after deploy)
fly secrets set --app kindle-digest \
  SMTP_HOST=smtp.gmail.com \
  SMTP_PORT=587 \
  SMTP_USER=you@gmail.com \
  SMTP_PASS=your-app-password \
  SMTP_FROM=you@gmail.com

# 4. Deploy
fly deploy
```

After deploy, open your app URL and go to **Feeds** to add your first feeds
or import an OPML file.

**Useful commands:**

```bash
fly logs --app kindle-digest          # tail live logs
fly ssh console --app kindle-digest   # shell into the container
fly deploy                            # redeploy after code changes
```

---

## Known limitations

- In-article images are not embedded in the EPUB body (the cover image **is**
  embedded and grayscaled). Use the per-article QR code to open the original.
- "Full content" detection is a text-length heuristic (`FULLTEXT_MIN_CHARS`).
  Tune it to your feeds — some feeds include full articles via `content:encoded`,
  others only summaries.
- Kindle series grouping relies on EPUB3 `belongs-to-collection` (ISO date as
  group position) plus a calibre series fallback. Verify in Kindle Previewer.
