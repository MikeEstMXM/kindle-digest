# 📚 kindle-digest

A single-user web app that turns your unread [Inoreader](https://www.inoreader.com)
articles into **daily Kindle digests**. It pulls unread articles grouped by
top-level Inoreader folder, lets you curate which ones go into today's digest,
and delivers **one EPUB per folder** — with a designed cover, full article
text, a per-article QR code to the source, and a diagnostics page — straight to
your Kindle, on a schedule and on demand.

Inoreader is the source of truth for feeds and read state. Articles you send are
marked **read in Inoreader**, so the change propagates to Reeder and everywhere
else automatically.

---

## ⚠️ Required setup: whitelist your sender on Amazon

**Send to Kindle silently drops email from unknown senders.** Before anything
will reach your device you MUST add your sending address to Amazon's approved
list:

1. Go to **Amazon → Manage Your Content and Devices → Preferences →
   Personal Document Settings**.
2. Under **Approved Personal Document E-mail List**, click **Add a new approved
   e-mail address**.
3. Add the exact address you configure as `SMTP_FROM` (e.g.
   `digest@yourdomain.com`).
4. Find your Kindle's **Send-to-Kindle e-mail** (`…@kindle.com`) on the same
   page — that is the `KINDLE_EMAIL` value.

If digests never arrive, this whitelist step is the first thing to check.

---

## How it works

```
Inoreader API ──► unread articles grouped by top-level folder
                      │
                  Dashboard (curate: include / exclude per article)
                      │
        ┌─────────────┴───────────────┐
   Full-text fetch                Cover + QR + diagnostics
   (Inoreader content if full,    (grayscale image, embedded fonts,
    else Readability.js fallback)  series metadata)
        └─────────────┬───────────────┘
                 One EPUB per folder
                      │
            SMTP ──► your @kindle.com address
                      │
            Mark articles read in Inoreader
```

- **Full text is always included.** If extraction fails (paywall, JS-rendered,
  HTTP error) the article is still included with a clear inline notice — never
  dropped, never truncated.
- **Series metadata** sets series name = folder, series index = ISO date, so
  Kindle groups each folder's digests into a browsable collection.
- **Covers** use a four-template design system assigned by a stable hash of the
  folder name (it never changes day-to-day). Fonts are embedded in the EPUB.

## Tech stack

Node.js 22 + TypeScript · Fastify + HTMX · better-sqlite3 · @mozilla/readability
+ jsdom · sharp · qrcode · custom EPUB writer (jszip) · luxon · nodemailer.
Hosting: Fly.io. See [`CLAUDE.md`](./CLAUDE.md) for full rationale.

## Prerequisites

- Node.js ≥ 22
- An Inoreader account and a **registered OAuth app**
  (https://www.inoreader.com/developers/ → *register a new application*).
  Set the redirect URI to exactly `${APP_BASE_URL}/auth/callback`.
- An SMTP account whose **from address is whitelisted on Amazon** (see above).

## Quick start (local)

```bash
git clone <repo> && cd kindle-digest
npm install
npm run fetch-fonts            # downloads + embeds the cover fonts (woff2)

cp .env.example .env           # then fill it in (see below)
npm run dev                    # http://localhost:3000
```

Then in the browser:

1. Open **Settings**, enter your Kindle email, delivery time, timezone, and
   SMTP details. Save.
2. Click **Connect Inoreader** and authorize.
3. On the **Dashboard**, toggle articles include/exclude, then **Send now** for
   a folder or **Send all**. The scheduler also delivers daily at your chosen
   time.

### Environment variables

Copy `.env.example` to `.env` and set:

| Variable | Required | Notes |
|----------|----------|-------|
| `CREDENTIAL_ENCRYPTION_KEY` | ✅ | 32 bytes for encrypting OAuth tokens at rest. Generate: `openssl rand -hex 32`. |
| `INOREADER_CLIENT_ID` / `INOREADER_CLIENT_SECRET` | ✅ | From your Inoreader developer app. |
| `APP_BASE_URL` | ✅ | Public base URL; the OAuth redirect is `${APP_BASE_URL}/auth/callback`. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | ✅ | `SMTP_FROM` must be Amazon-whitelisted. Can also be set in the Settings UI. |
| `KINDLE_EMAIL` | ✅ | Your `…@kindle.com` address (or set in Settings). |
| `DELIVERY_TIME` / `TIMEZONE` | – | Daily send time (HH:mm, 24h) and IANA timezone. |
| `DATABASE_PATH` | – | SQLite path. On Fly this lives on the mounted volume. |
| `FULLTEXT_MIN_CHARS` | – | Min chars before Inoreader content is treated as "full" (else Readability). |

Credentials are never hardcoded: OAuth tokens are stored **encrypted**
(AES-256-GCM) in SQLite; SMTP secrets live in env or the local DB.

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Dev server + scheduler (tsx watch). |
| `npm run fetch-fonts` | Download + embed the cover fonts. |
| `npm test` | Run the test suite (core logic). |
| `npm run lint` / `npm run typecheck` | Lint / type-check. |
| `npm run build` && `npm start` | Compile and run production build. |
| `npx tsx scripts/smoke-epub.ts` | Build a sample EPUB to `out/sample.epub` for inspection. |

## Deploy to Fly.io

```bash
fly launch --no-deploy            # adjust app name/region in fly.toml
fly volumes create kindle_digest_data --size 1
fly secrets set \
  CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -hex 32) \
  INOREADER_CLIENT_ID=... INOREADER_CLIENT_SECRET=... \
  SMTP_HOST=... SMTP_USER=... SMTP_PASS=... SMTP_FROM=... \
  KINDLE_EMAIL=...@kindle.com
fly deploy
```

Set `APP_BASE_URL` (in `fly.toml` `[env]`) to your real Fly URL and make sure
that `${APP_BASE_URL}/auth/callback` is registered as the redirect URI in your
Inoreader app. One always-on machine runs the daily scheduler; SQLite + tokens
persist on the volume.

## Known limitations (v1)

- In-article images are dropped from the body to keep EPUBs self-contained and
  small (the cover image **is** embedded, grayscaled). Use the per-article QR to
  open the original for full fidelity.
- "Full content" from Inoreader is detected by a text-length heuristic
  (`FULLTEXT_MIN_CHARS`); tune it to your feeds.
- Kindle series grouping relies on EPUB3 `belongs-to-collection` (the ISO date
  is used as the group position); a calibre series fallback is also written.
  Verify grouping in Kindle Previewer if needed.
