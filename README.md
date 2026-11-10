# kindle-digest

A single-user web app that turns your RSS feeds into **daily Kindle digests**.
It manages its own feed list, lets you curate which articles go into today's
digest, and builds **one digest per folder** — with a designed cover, full
article text, a per-article QR code back to the source, and a diagnostics page
— delivered to your Kindle on a schedule and on demand.

No external RSS reader required. All feeds and read state live in a local
SQLite database on your Fly.io volume.

---

## Two ways to get a digest onto the Kindle

Pick one under **Settings → Delivery mode** (or the `DELIVERY_MODE` env var for
the first-run default).

| | **Download** (`download`, the default) | **Email** (`email`) |
|---|---|---|
| What is delivered | A Kindle *periodical* `.mobi`, one per folder per day | The EPUB, by SMTP to your `@kindle.com` address |
| Issues stack under one title with a cover tile | **Yes** | No — Amazon turns every attachment into an ordinary document |
| Needs SMTP | **No — never touches it** | Yes (and the whitelist step below) |
| How it reaches the Kindle | You sign in on the Kindle's web browser, open **Issues** and tap one | Amazon delivers it |
| Needs calibre | Yes (in the Docker image) | No |

### Signing in

The app has its own login, so it can be public on the internet (no Cloudflare
Access needed). There is one account, **`mharm`**; there is no sign-up page.

- **First run.** The account starts with no password. Open `/setup`, choose a
  password (at least 12 characters, typed twice) and you're done: `/setup` then
  returns **404 forever**. The password is typed into the page by you; it never
  goes through an environment variable or anyone else. **Keep Cloudflare Access
  on until you have done this**, so only you can reach `/setup` (whoever submits
  it first sets the password).
- **Signing in.** `/login` is a plain HTML form with no JavaScript, so it works in
  the Kindle's Experimental Browser. Tick **Keep me signed in** on the Kindle for
  a one-year session; otherwise a session lasts 30 days. Sessions live in the
  database; the cookie is `HttpOnly; Secure; SameSite=Lax`. **Sign out** is in the
  top bar.
- **Changing the password** is on the **Settings** page and needs the current
  password. It signs every other device out.
- **Everything else needs a session**: any request without one is redirected to
  `/login?next=…`. The only open paths are `/login`, `/setup` (until a password
  exists), `/healthz` and the htmx script.
- **Forms are CSRF-protected** with a hidden token (no JavaScript needed).
- **Failed sign-ins are rate-limited**: 5 per 15 minutes per address (the
  `CF-Connecting-IP` header when Cloudflare sends one, else the connection's own
  address), and every failure is logged.
- **Forgot the password?** Clear it from the host, then visit `/setup` again
  (this keeps all your data):
  `sqlite3 <database file> "UPDATE users SET password_hash = NULL WHERE username = 'mharm'; DELETE FROM sessions;"`.
  Do this only while Cloudflare Access is on, for the same reason as above.

> **Deploying this behind Cloudflare:** the container must be reachable *only*
> through the tunnel (bind its port to `127.0.0.1`, never `0.0.0.0` or a LAN
> address). The rate limit trusts the `CF-Connecting-IP` header, which anyone could
> forge if they could reach the port directly. The old port-3100 mapping is gone —
> remove it from any compose file.
>
> **Upgrading from the pre-login version:** the first start migrates the database
> (adds the `mharm` account and per-user ownership) and the old image cannot use it
> afterwards. Stop the old container and copy the SQLite file together with its
> `-wal` and `-shm` files before the first deploy; rolling back means the old image
> plus that copy.

### The issue archive

**Issues** in the top bar (`/issues`) lists each folder with its latest issue and
how many there are; a folder's page lists **every** issue, newest first, with
the date, size, a small cover and a big **Download** button. On the Kindle:
**Experimental Browser → `https://digest.g1zoolu.com/issues`** → tap **Download** → it lands
in the library and stacks with earlier issues of the same folder. Downloads are
served as `application/x-mobipocket-ebook` attachments. The pages are plain HTML
with large tap targets and no JavaScript.

- Every issue is kept (`KINDLE_KEEP_ISSUES` unset or `0`); set it to a number to
  keep only that many per folder.
- The issue list is an index in the database (so it knows which user owns what).
  At startup it is brought in line with the files in `KINDLE_DIR`, so issues from
  before the archive existed appear on their own.
- Each issue is made by converting the built EPUB with
  [calibre](https://calibre-ebook.com)'s `ebook-convert` as a separate process:
  the OPF is switched to version 2.0 with a `periodical:magazine:<Folder>` type and
  an OPF 2 cover, and converted with `--share-not-sync` (no ASIN, or the Kindle
  tile shows no cover). The result is checked before it is published; an issue
  that is not a proper periodical is rejected, not served. Details and the
  reasons are in [`docs/decisions.md`](./docs/decisions.md).
- A delivery is marked **published** (instead of *sent*) and shown on the
  dashboard's *Recent deliveries* panel; a failed conversion shows there too,
  with its error. No email is sent in this mode, including failure alerts.

### Backfilling past issues

Two tools bring older digests into `/issues`. Neither sends mail, touches
`delivery` rows or articles, or deletes any issue.

**1. `import-issue`** (inside the app's container; it uses the app's own
`DATABASE_PATH`, `KINDLE_DIR` and calibre):

```bash
# one issue: a digest .epub, an unpacked EPUB directory, or a build staging directory
node dist/import/main.js --folder Money --date 2026-11-02 /in/money-2026-11-02.epub
node dist/import/main.js --folder News  --date 2026-11-01 /in/.staging-news-2026-11-01

# everything in a directory: "<Folder>-<YYYY-MM-DD>.epub" and ".staging-<Folder>-<YYYY-MM-DD>/"
# (what fetch-sent-digests.py writes); *.azw3 and other files are ignored
node dist/import/main.js --dir /in
```

It converts with the same pipeline as a live issue and files the result as
`<KINDLE_DIR>/<folder-slug>/<slug>-<original date>.mobi`, so it sorts by its own
date in `/issues`, then adds it to the index. An issue that already exists is
skipped (`skipped …`), unless `--force`. One line per issue; exit code 1 if any
failed. A **staging directory** (what an interrupted build leaves: only
`art-N.xhtml` pages and `images_*` files) is rebuilt into an EPUB first, with the
contents page, sections, cover and navigation regenerated from the pages; missing
pages or pictures are reported on the line and left out cleanly. `--dir` takes the
folder's proper name ("Money") from the app's own folders. It refuses to run as
root against files owned by another user, and refuses to create a new database.

**2. `scripts/fetch-sent-digests.py`** (standalone Python, stdlib only; run on the
host, not in the app): downloads the `.epub` attachments from Gmail's Sent Mail.

```bash
python3 scripts/latest-sent.py copy-of-kindle-digest.sqlite > map.csv   # message_id,folder,date; newest 10 per folder
export GMAIL_IMAP_USER=...  GMAIL_IMAP_PASS=...      # a Gmail app password, in the environment only
python3 scripts/fetch-sent-digests.py --map map.csv --out ./epubs       # writes <folder>-<date>.epub
python3 -m unittest scripts/test_fetch_sent_digests.py                  # its tests (no network)
```

It opens `[Gmail]/Sent Mail` with `EXAMINE` (read-only), reads messages with
`BODY.PEEK`, searches `HEADER Message-ID` per id, and reports `found`/`missing`
per id (exit 1 if any are missing). The password is never printed. `--ids file`
limits it to the Message-IDs listed in a file. The "newest 10 per folder" list is
plain SQL if you prefer (it is in the `latest-sent.py` header).

### Email mode: whitelist your sender on Amazon

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
       ┌──────────────┴───────────────┐
  download mode                   email mode
  calibre → periodical .mobi      SMTP ──► your @kindle.com address
  → Issue archive (/issues, login)      │
       └──────────────┬───────────────┘
                      │
         delivery marked published / sent
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
npm run fetch-fonts      # cover fonts: woff2 (EPUB) + ttf (cover rendering)

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
| `DIGEST_DIR` | – | Where built `.epub` files are staged. On Fly this must be on the volume (`/data/digests`) so a failed send can retry without rebuilding. |
| `ALERT_EMAIL` | – | Where delivery-failure alerts go. Defaults to `SMTP_FROM`. |
| `DELIVERY_MAX_ATTEMPTS` | – | Retries before a delivery is marked failed and alerted. Default `5`. |
| `BUILD_CONCURRENCY` | – | Articles fetched/rendered in parallel. Default `4`. Trades peak memory for build speed — lower it to `2` if builds run hot on a 512 MB VM. |
| `DELIVERY_MODE` | – | `download` (default: issue archive, no email) or `email`. First-run default only; the Settings page choice (stored in the DB) wins. Anything else means `download`. |
| `KINDLE_DIR` | – | Where published `.mobi` issues live (the only files `/issues` can serve). Default `./data/kindle`; `/data/kindle` in Docker (on the volume). |
| `KINDLE_KEEP_ISSUES` | – | Issues kept per folder. **Unset or `0` keeps every issue** (the default). A positive number keeps only the newest N. |
| `SESSION_SECRET` | – | Any long random string. Signs the one-time tokens on the login and setup forms. If unset a random one is made at startup, which only means a login page left open across a restart needs a reload. Logged-in sessions do not depend on it. |
| `EBOOK_CONVERT_BIN` | – | calibre's `ebook-convert`. Default: found on `PATH` (`/opt/calibre` in the image). |
| `CONVERT_TIMEOUT_MS` | – | Kill a conversion after this long. Default `1200000` (20 min). A 34 MB EPUB converts in about 35 s. |

No OAuth tokens or encryption keys are required. The login password is never an
environment variable: it is set at `/setup` and stored only as a scrypt hash.

`KINDLE_PORT` no longer exists (the separate Kindle listener was removed); it is
ignored if it is still set.

---

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Dev server + scheduler (tsx watch). |
| `npm run fetch-fonts` | Download the cover fonts (woff2 + ttf). Both formats are committed, so this is normally a no-op. |
| `npm test` | Run the test suite (core logic). |
| `npm run lint` / `npm run typecheck` | Lint / type-check. |
| `npm run build` && `npm start` | Compile and run production build. |
| `npx tsx scripts/smoke-epub.ts` | Build a sample EPUB to `out/sample.epub` for inspection. |

---

## Running the Docker image (home server)

```bash
# One port. Put TLS (Cloudflare tunnel, reverse proxy) in front of it:
# the session cookie is Secure, so sign-in needs https (or localhost).
docker build -t kindle-digest .
docker run -d --name kindle-digest -v kindle-digest-data:/data \
  -e SESSION_SECRET=<long random string> \
  -p 127.0.0.1:3000:3000 kindle-digest
```

The image bundles calibre (pinned by the `CALIBRE_VERSION` build arg) for the
MOBI conversion, which makes it large (~2.8 GB). Conversion peaks around 300 MB
for the biggest (34 MB EPUB) digest, on top of the app itself. SMTP variables
are not needed in the default `download` mode.

## Deploy to Fly.io

> The Fly deployment predates the issue archive and is being retired. The image
> now contains calibre and `download` is the default mode, so a Fly deploy would
> stop emailing unless `DELIVERY_MODE=email` is set (and a 512 MB VM is tight for
> conversions). Fly deploys remain manual.

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

### Deploying without a terminal

`.github/workflows/deploy.yml` deploys from the browser: **Actions → Deploy to
Fly → Run workflow**, choosing the branch to ship. It is `workflow_dispatch`
only — nothing deploys as a side effect of a push, so a deploy is always a
deliberate act.

Two one-time setup steps, both browser-only:

1. **Fly dashboard → `kindle-digest` → Tokens** → create a **deploy token**.
   Scope it to this app; an account-wide token in CI can reach everything else
   you own.
2. **GitHub → repo Settings → Secrets and variables → Actions** → new repository
   secret named `FLY_API_TOKEN`, pasting that token.

Until the secret exists the workflow fails with an authentication error.

### Checking what a build cost

Every EPUB's diagnostics page (last page in the book) reports build time, images
embedded, and **peak memory against the 512 MB VM**, with the
`BUILD_CONCURRENCY` that produced it. To read it without waiting for Kindle
delivery, use the **Download** button on the dashboard and open the file.

The memory figure is measured *before* the EPUB is zipped, so it excludes final
assembly — about 30 MB short of the whole-build peak on a large digest. The
complete figure is stored in `run_log` and appears in failure-alert emails.

If peak memory is uncomfortably close to 512 MB, lower the concurrency from the
Fly dashboard (Secrets → `BUILD_CONCURRENCY=2`); it takes effect on restart, no
redeploy needed.

---

## Known limitations

- In-article images are not embedded in the EPUB body (the cover image **is**
  embedded and grayscaled). Use the per-article QR code to open the original.
- "Full content" detection is a text-length heuristic (`FULLTEXT_MIN_CHARS`).
  Tune it to your feeds — some feeds include full articles via `content:encoded`,
  others only summaries.
- Kindle series grouping relies on EPUB3 `belongs-to-collection` (ISO date as
  group position) plus a calibre series fallback. Verify in Kindle Previewer.
