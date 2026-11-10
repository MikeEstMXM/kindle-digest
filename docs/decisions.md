# Decisions

What was chosen and why, newest first. Short on purpose.

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

**Separate listener for the Kindle page** (`src/kindle/`, `KINDLE_PORT`, 3100).
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

**Issues** live at `<KINDLE_DIR>/<folder-slug>/<slug>-<YYYY-MM-DD>.mobi`; the
newest 7 per folder are kept (never fewer than 1). The file appears via rename
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
