# Decisions

What was chosen and why, newest first. Short on purpose.

## Backfilling past issues (`import-issue`, Gmail fetch)

**Why.** The archive only had issues published since download mode began; the
older digests exist as EPUBs (Fly volume recovery, Gmail Sent Mail).

**Reuse, not a second pipeline.** `import-issue` calls `publishIssue()` (the live
path: OPF 2 periodical, OPF 2 cover, `--share-not-sync`, EXTH check) with
`keepIssues: 0`, then `IssueRepo.record()`. Never prunes, never sends, never
touches `delivery`/`articles`. The file on disk decides "already exists"; the
index is only written after a successful conversion.

**Staging dirs are not unpacked EPUBs.** The recovered `.staging-news-2026-11-01`
held only the article pages and `images_*` files (the orchestrator stages just
those; the OPF, cover, contents and NCX are made at zip time and were never
written). So the importer rebuilds an EPUB from them with the same builders a live
digest uses (`buildSectionIndexPage`, `buildTocPage`, `buildNcx`, `buildEpubToFile`).
Facts come from the pages themselves: title (`h1`), feed (first part of the meta
line), section (`feed-K-index.xhtml` link in the nav bar), so no database is needed.
The cover uses the folder's own template/theme and the first article photo; it is
a regenerated cover, not the original. Pages that were never staged (gaps in
`art-N`) are left out; dangling Prev/Next links and `<img>`s are repaired.
A directory that already is an unpacked EPUB is just zipped (mimetype first, stored).

**Caveat on that staging dir.** It is a partial, interrupted build whose articles
span 27 Oct – 9 Nov (the build ran on 10 Nov), so "News 2026-11-01" is not a
faithful issue of that date; it was imported because it was asked for.

**Root vs app user.** The app container runs as root, so `docker exec` as root
is right there. The CLI refuses to run as root against files owned by another uid,
so it cannot leave root-owned files an unprivileged app could not write.

**`--dir` and folder names.** The slug in a file name loses case ("money"), but the
issue's folder name is what goes into the OPF title and the /issues heading, so
`--dir` maps slug → real name via the app's folders and fails the file (with the
known names) instead of guessing.

**Gmail fetch is a script, not app code.** Python stdlib (`imaplib`), host-side,
so the app image gains no mail-reading code and no Gmail credential. `EXAMINE`
+ `BODY.PEEK`; a fake-IMAP test asserts that only SELECT/SEARCH/FETCH are issued.
Falls back to the mailbox flagged `\Sent` if the English name does not exist
(localised Gmail). Searching is by Message-ID only; a message whose ID Gmail
rewrote shows as `missing` rather than being matched by guesswork.

## App login, accounts and the issue archive

**Why.** The user wants to download issues on the Kindle from
`https://digest.g1zoolu.com`. The Kindle browser cannot pass Cloudflare Access,
so Access comes off and the app must protect itself. Until now it had no auth at
all: anyone reaching it could edit feeds and trigger sends. This replaces the
separate login-free Kindle listener (below, now removed).

**Accounts.** A `users` table seeded with exactly one row, `mharm` (always id 1);
no sign-up, no multi-user UI. `password_hash` is NULL until the owner sets one at
`/setup`.
- *Ownership is real on the tables, single-user in the queries.* `user_id`
  (NOT NULL, foreign key) is on `feeds` (so folders), `settings`,
  `folder_settings`, `delivery` and `issues`, with uniqueness per user
  (`UNIQUE(user_id, url)`, `PRIMARY KEY(user_id, key)`, ...). Each repository
  takes a `userId` (the owner, looked up at startup) and filters on it, so a
  second user is an INSERT plus a loop in the scheduler, not a schema change.
  What is *not* scoped yet: `article_selection` and `run_log`/`article_log`
  (keyed by article/run ids that are already globally unique), the scheduler and
  delivery worker (one global schedule and one settings set), and the web layer
  (one fixed owner). That is the part to do if a second user ever appears.
- *Migration* (`adoptOwner` in `src/db/schema.ts`). SQLite cannot add a NOT NULL
  foreign key column or change a UNIQUE/PRIMARY KEY in place, so the four
  tables are rebuilt (create new, copy every row with ids preserved, drop old,
  rename), in one transaction, with foreign keys switched off for it (with them on,
  dropping `feeds` would cascade-delete every article). A foreign-key check
  before commit rolls back if the migration orphaned anything; rows that were
  already dangling beforehand do not block startup. `AUTOINCREMENT` counters are
  carried over. It runs on each start but only touches tables still missing
  `user_id`. Tested on a live-shaped database (33 feeds, 132 articles, 60
  deliveries, ...) and on an older shape; also run against a copy of the real DB
  before this was handed over.

**Password.** scrypt (`N=2^16, r=8, p=1`, 16-byte salt) via Node's built-in
`crypto`; the parameters are stored in the hash so they can be raised later. No
dependency to build on the image. Minimum 12 characters (max 256, only to bound
the work a request can cause). `/setup` is a conditional UPDATE
(`... WHERE password_hash IS NULL`) so two simultaneous submissions cannot both
win, and answers 404 once a password exists. It is deliberately unauthenticated;
the protection during first setup is that Cloudflare Access stays on until the
user has set the password. There is no env var for the password, by request.

**Sessions.** Random 256-bit id in an `HttpOnly; Secure; SameSite=Lax` cookie;
only its SHA-256 is stored, so a leaked database cannot be replayed. 30 days, or a
year with "keep me signed in" (the Kindle). Fixed lifetime, not sliding. A new id
on every login. A password change ends every other session. `Secure` is always
on: the app must be reached over https (curl and browsers also accept
`localhost`).

**Login answers 200, not 302 (Kindle).** From the Kindle (11th gen, Experimental
Browser) a successful `POST /login` was followed by a bounce back to `/login`:
the browser did not keep a cookie set on the 302. The cookie is now set on a 200
page with `<meta http-equiv="refresh" content="0;url=NEXT">` and a visible
"Signed in, continue" link; `NEXT` still goes through `safeNext` and is HTML-escaped.
Attributes were left alone on purpose (`HttpOnly; Secure; SameSite=Lax`, Max-Age +
Expires). Each gate redirect logs `gate redirect to login` with an 8-hex hash of
the Cookie header, whether `kd_session` was sent and found, and the user-agent
(never the token), so a failed Kindle attempt shows whether the cookie came back.
If the Kindle still fails, the next candidates are dropping `SameSite` or sending
`Max-Age` only; both weaken other browsers slightly and need the owner's say-so.

**The gate** is one global `onRequest` hook with a four-entry allow-list
(`/login`, `/setup`, `/healthz`, the htmx script), so a route added later is
protected by default. Unknown URLs also redirect to login rather than revealing
what exists. htmx requests get a 401 + `HX-Redirect` instead of a login page to
swap into a fragment. A test reads the route declarations from the source and
fails if one is neither covered by the redirect tests nor on the allow-list.

**CSRF.** Logged-in pages: a per-session random token stored in `sessions`,
required on every non-GET request, accepted as a hidden form field, an
`X-CSRF-Token` header (htmx, set once on `<body>`), or `?_csrf=` (the OPML
upload, whose multipart body is not parsed when the check runs). The token is
added to every `method="post"` form in one place (`withCsrf` in
`src/web/views.ts`) instead of in each view; a test crawls the pages and fails on
any POST form without one. Login/setup have no session yet, so they use a signed,
expiring (2 h) token (HMAC with `SESSION_SECRET`, or a random per-process key
when unset). That stops cross-site login CSRF; it is not bound to the visitor.

**Rate limit.** 5 attempts per 15 minutes per address, kept in `login_failures`
(survives restarts). Each attempt is written down *before* the slow password hash
runs and wiped again if the password is right, so a burst of parallel guesses
cannot all slip through while the first is still hashing (a reviewer measured 40
of 40 getting through with record-after-failure; now exactly 5). It is checked
before the password, so a correct guess during lockout still fails. IPv6 is
counted per /64, because one visitor owns a whole /64 and could otherwise rotate
addresses. The address is `CF-Connecting-IP` when it is a valid IP, else the
socket address; that header is only trustworthy because the container is
reachable solely through the Cloudflare tunnel. **If the port were ever published
on the LAN or the internet directly, anyone could spoof the header and the limit
would mean nothing** (deploy note in README). A wrong *current* password on the
Settings page counts too. An unknown username does the same hashing work as a
wrong password (the dummy hash is made at startup so even the first miss is not
slower). Failures are logged with the address and whether the username matched —
not the username (on a Kindle keyboard people type the password into it) and
never the password. No global cap across all addresses: it would let anyone with
a few requests an hour lock the owner out of new sign-ins, which is worse than the
risk it covers given a 12+ character password and a ~200 ms hash.

**Issue archive.** `issues` table = index of the `.mobi` files (slug, real folder
name, date, size, owner); `/issues`, `/issues/<folder>`, `/issues/<folder>/<file>`
and `.../<file>/cover.jpg`. The index is updated on publish and reconciled with
`KINDLE_DIR` at startup (adds files it has not seen, forgets vanished ones, but
never wipes itself if the directory cannot be read). A download requires the row
*and* a strict name match *and* an `lstat` regular file (symlinks refused). Pages
are plain HTML, no JS, large tap targets.
- *Thumbnails* are cut from the MOBI itself (MOBI header offset 0x5C = first image
  record, EXTH 201 = cover offset), resized with sharp to 120 px, kept in a small
  in-memory cache. Only the newest 24 issues of a folder show one; the rest are
  text rows, so a year of daily issues does not make the e-ink browser fetch 365
  images.
- *Retention:* `KINDLE_KEEP_ISSUES` unset or `0` keeps everything (the new
  default; it was 7). A typo also means "keep everything", never "delete".
  `pruneIssues` still clamps to at least 1 and is only called when a limit is set.

**Review.** A fresh reviewer tried to break it (gate bypass by URL/method tricks,
CSRF, open redirect, fixation, rate-limit races, path traversal, malformed MOBI,
XSS, migration). Fixed from that: a `?next=` with a non-ASCII or DEL character
crashed the whole process when redirected to (now only printable ASCII paths are
accepted); the parallel-guess race and IPv6 rotation above; malformed MOBI
headers now mean "no thumbnail" rather than a 500; downloads open with
`O_NOFOLLOW`; the AUTOINCREMENT counter is kept for a table that is empty at
migration time; the failure log no longer stores the typed username; the
`?_csrf=` token of an upload is scrubbed from the request log. Known and
accepted: `/setup` is open to whoever gets there first (hence "keep Cloudflare
Access on until the password is set"); the session cookie is not `__Host-`
prefixed (a sibling subdomain could shadow it, which at worst logs you out — a new
session id is issued on every login); no CSP/HSTS (the dashboard uses inline
handlers; set HSTS in Cloudflare); `/download*` are GETs that build an EPUB, so a
cross-site link can make the server do work (needs a signed-in visitor, no data
leaves); the login form token is not bound to the visitor.

**Upgrading a running instance.** The ownership migration cannot be undone by the
old image (its INSERTs do not know `user_id`). Before the first deploy: stop the
old container, copy the SQLite file *with* its `-wal` and `-shm` files, deploy.
Rolling back = old image + that copy.

**Removed:** the second Fastify listener on 3100 (`src/kindle/server.ts`,
`KINDLE_PORT`, the Dockerfile `EXPOSE 3100`). Its safeguards moved to the
archive routes (path validation, symlink refusal, nosniff), now behind login; the
old traversal test list was ported to `test/issues.test.ts`.

**Dead ends / notes**
- The MOBI "first image index" is at 0x5C of the MOBI header, not 0x6C (0x6C is
  something else); found by reading a real calibre file.
- `@fastify/cookie`/`@fastify/session` were not used: the cookie handling is ~15
  lines and avoids a dependency whose defaults (signing, stores) would need
  overriding anyway.
- Tests run on Node 22 inside the image: `better-sqlite3` does not build on the
  host's Node 26. `cover-fonts` "resolves Bebas Neue" still fails in the image
  (pre-existing, unrelated).

## Periodical delivery (Kindle page + calibre MOBI)

**Why.** Amazon's email route turns every attachment into an ordinary document,
so issues never stack and tiles have no cover. A calibre-built *periodical*
MOBI downloaded in the Kindle's own browser stacks under one title and shows a
cover. Proven on the user's Kindle (base 11th gen, 2024) by Boss; test files and
notes are in `~/boss/projects/kindle-digest/periodical-test/`.

**The recipe** (`src/mobi/`), applied to a *copy* of the EPUB the app already builds:

1. `content.opf` → `version="2.0"`. calibre ignores the publication type on OPF 3.
2. Add `<meta name="calibre:publication_type" content="periodical:magazine:<Folder>"/>`
   → EXTH 501 = `NWPR`.
3. Add `<meta name="cover" content="<id of the cover-image item>"/>`. EPUB 3's
   `properties="cover-image"` is ignored by calibre and the cover is lost.
4. `ebook-convert in.epub out.mobi --output-profile kindle --share-not-sync`.
   `--share-not-sync` omits EXTH 113 (ASIN); with an ASIN present the Kindle
   tile shows no cover (verified on the device).
5. The result is read back (`src/mobi/exth.ts`) and **rejected unless** it has
   501 = NWPR, no 113, and a cover (201). A silent calibre change then shows as a
   failed delivery instead of a coverless book that doesn't stack.

The email path is untouched: it still sends the original EPUB.

**Separate listener for the Kindle page** (`src/kindle/`, `KINDLE_PORT`, 3100) — *removed; superseded by the app login above.*
The Kindle browser can't pass Cloudflare Access and the main app has no login,
so the thing published on the LAN must be a different server that cannot reach
the dashboard. It is handed only a directory, has two routes (list, download),
validates names against strict patterns *and* against the real directory
listing of regular files (symlinks ignored), and 404s everything else. Tests
cover traversal, the app's own paths, and write methods.

**calibre is a separate process**, never imported (keeps its GPL code out of the
app). Pinned by the `CALIBRE_VERSION` Dockerfile arg; the official installer
verifies the tarball against calibre's sha512. The app's `LD_PRELOAD` (jemalloc)
is removed from the child's environment.

**State.** `delivery.state` gains `published` (download mode's `sent`) and a
`mobi_path` column. Conversion failures use the same retry/`failed` machinery as
sends, except timeouts and "not a periodical" failures, which are deterministic
and not retried. In download mode no failure alert email is attempted
(`SMTP` is never touched); the dashboard's *Recent deliveries* panel is the
record. The delivery mode is read per delivery, so flipping it applies to the
next row.

**Default is `download`**, per the user's decision to turn email delivery off.
Anything unrecognised parses as `download`, never `email`.

**Issues** live at `<KINDLE_DIR>/<folder-slug>/<slug>-<YYYY-MM-DD>.mobi`; all are
kept by default (originally the newest 7). The file appears via rename
from a dot-prefixed work dir on the same volume, so the Kindle never fetches a
half-written file. Re-running a date overwrites that date's issue.

**Measured** (calibre 9.18.0, real DB copy): News 34 MB EPUB → 46 MB MOBI in
~33 s, largest process peak ~300 MB RSS. Default timeout is 20 min.

**Dead ends / surprises**
- The brief said to "mark articles read, as a send does today". It doesn't: read
  state was removed (commit `ef3a8d6`) in favour of time-windowed queries, and
  `articles.status` is never updated. Nothing was added; publishing records
  `delivery.state = published` instead. (`CLAUDE.md` still describes mark-as-read
  and the old "never emit MOBI" rule — it needs updating; a protected file I
  could not edit.)
- The MOBI EXTH flag is at offset 0x70 of the MOBI header, not 0x80 (found by the
  real-conversion test, which is why that test exists).
- `test/cover-fonts.test.ts` "resolves Bebas Neue" fails *inside the Docker image*
  (also in the pre-change image) and passes on the host; unrelated to this work.
- The dashboard had no delivery status at all, so "visible on the dashboard like a
  failed delivery is today" needed a new *Recent deliveries* panel.
- calibre roughly triples the image (1.17 GB → 2.8 GB). Possible trims
  (QtWebEngine ~200 MB, `resources/langtool` ~245 MB) were not taken: unneeded for
  EPUB→MOBI but they make a pinned upgrade riskier.
