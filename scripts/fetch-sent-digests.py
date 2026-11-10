#!/usr/bin/env python3
"""Download past digest EPUBs from Gmail's Sent Mail (read-only).

Standalone: stdlib only, not part of the app. For each Message-ID it finds the
sent message, takes the .epub attachment and saves it as <folder>-<date>.epub,
the file name `import-issue --dir` expects.

    export GMAIL_IMAP_USER=you@gmail.com
    export GMAIL_IMAP_PASS=...            # a Gmail app password; never passed on the command line
    python3 scripts/latest-sent.py DB.sqlite > map.csv
    python3 scripts/fetch-sent-digests.py --map map.csv --out ./epubs

--map  CSV lines `message_id,folder,date` (what latest-sent.py prints).
--ids  Optional file of Message-IDs, one per line, to fetch from the map; without
       it every id in the map is fetched.
--out  Output directory (created). Files that are already there are kept, so a
       run that stopped halfway can simply be started again; --overwrite replaces.

The mailbox is opened with EXAMINE (read-only) and messages are read with
BODY.PEEK, so nothing is flagged, moved or deleted. The password is read from
the environment only and is never printed.

Exit code: 0 all found, 1 some missing or unusable, 2 could not connect or bad input.
"""
import argparse
import email
import email.policy
import imaplib
import os
import re
import sys
import zipfile
from email.message import EmailMessage
from pathlib import Path

HOST = "imap.gmail.com"
SENT_MAILBOX = "[Gmail]/Sent Mail"


class FetchError(Exception):
    """A problem to report in one line (never contains the password)."""


def read_mapping(path: str) -> dict[str, tuple[str, str]]:
    """message_id -> (folder, date) from `message_id,folder,date` lines."""
    mapping: dict[str, tuple[str, str]] = {}
    for n, raw in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p.strip() for p in line.split(",")]
        if len(parts) != 3 or not all(parts):
            raise FetchError(f"{path} line {n}: expected message_id,folder,date")
        message_id, folder, date = parts
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
            raise FetchError(f"{path} line {n}: date {date!r} is not YYYY-MM-DD")
        mapping[message_id] = (folder, date)
    return mapping


def read_ids(path: str) -> list[str]:
    return [l.strip() for l in Path(path).read_text(encoding="utf-8").splitlines() if l.strip() and not l.startswith("#")]


def output_name(folder: str, date: str) -> str:
    """<folder>-<date>.epub, with anything that is not a plain file-name character replaced."""
    return f"{re.sub(r'[^A-Za-z0-9._-]+', '-', folder).strip('-.') or 'folder'}-{date}.epub"


def search_term(message_id: str) -> str:
    """The id as an IMAP quoted string. Gmail matches it as a substring of the header."""
    bare = message_id.strip().lstrip("<").rstrip(">")
    if not bare or re.search(r'[\x00-\x1f\x7f"\\]|[^\x00-\x7f]', bare):
        raise FetchError(f"not a usable Message-ID: {message_id!r}")
    return f'"{bare}"'


def find_epub(msg: EmailMessage) -> tuple[str, bytes] | None:
    """The first .epub attachment of a message, as (file name, bytes)."""
    for part in msg.walk():
        name = part.get_filename() or ""
        if name.lower().endswith(".epub") or part.get_content_type() == "application/epub+zip":
            data = part.get_payload(decode=True)
            if data:
                return name or "digest.epub", data
    return None


def looks_like_epub(path: Path) -> bool:
    try:
        with zipfile.ZipFile(path) as z:
            return z.namelist()[:1] == ["mimetype"] and z.read("mimetype") == b"application/epub+zip"
    except (zipfile.BadZipFile, OSError, IndexError, KeyError):
        return False


def select_sent(conn: imaplib.IMAP4_SSL) -> None:
    """EXAMINE the Sent Mail mailbox (read-only), falling back to whatever Gmail marks \\Sent."""
    status, _ = conn.select(f'"{SENT_MAILBOX}"', readonly=True)
    if status == "OK":
        return
    status, boxes = conn.list()
    for raw in boxes or []:
        line = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw)
        if "\\Sent" in line:
            name = line.rsplit(' "/" ', 1)[-1].strip()
            if conn.select(name, readonly=True)[0] == "OK":
                return
    raise FetchError(f"could not open {SENT_MAILBOX!r} read-only")


def fetch_one(conn: imaplib.IMAP4_SSL, message_id: str) -> tuple[str, bytes] | None:
    """Search Sent Mail for one Message-ID and return its epub attachment, or None."""
    status, data = conn.uid("SEARCH", None, "HEADER", "Message-ID", search_term(message_id))
    if status != "OK" or not data or not data[0]:
        return None
    for uid in data[0].split():
        # BODY.PEEK[] reads without setting \Seen (EXAMINE would refuse to anyway).
        status, parts = conn.uid("FETCH", uid, "(BODY.PEEK[])")
        if status != "OK" or not parts:
            continue
        raw = next((p[1] for p in parts if isinstance(p, tuple)), None)
        if raw is None:
            continue
        found = find_epub(email.message_from_bytes(raw, policy=email.policy.default))  # type: ignore[arg-type]
        if found:
            return found
    return None


def run(
    conn: imaplib.IMAP4_SSL,
    jobs: list[tuple[str, str, str]],
    out_dir: Path,
    overwrite: bool = False,
    say=print,
) -> int:
    """Fetch every (message_id, folder, date) job. Returns the exit code."""
    out_dir.mkdir(parents=True, exist_ok=True)
    select_sent(conn)
    missing = 0
    for message_id, folder, date in jobs:
        dest = out_dir / output_name(folder, date)
        label = f"{folder} {date} {message_id}"
        if dest.exists() and not overwrite:
            say(f"exists   {label} -> {dest.name}")
            continue
        try:
            found = fetch_one(conn, message_id)
        except (FetchError, imaplib.IMAP4.error) as err:
            say(f"error    {label}: {err}")
            missing += 1
            continue
        if found is None:
            say(f"missing  {label}")
            missing += 1
            continue
        tmp = dest.with_name(f".{dest.name}.part")
        tmp.write_bytes(found[1])
        if not looks_like_epub(tmp):
            tmp.unlink()
            say(f"bad      {label}: attachment {found[0]!r} is not a valid EPUB")
            missing += 1
            continue
        tmp.replace(dest)
        say(f"found    {label} -> {dest.name} ({len(found[1]) / 1024 / 1024:.1f} MB)")
    say(f"{len(jobs) - missing} of {len(jobs)} ok, {missing} missing")
    return 1 if missing else 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Download past digest EPUBs from Gmail Sent Mail (read-only).")
    ap.add_argument("--map", required=True, help="CSV of message_id,folder,date")
    ap.add_argument("--ids", help="file of Message-IDs to fetch (default: every id in the map)")
    ap.add_argument("--out", required=True, help="output directory")
    ap.add_argument("--overwrite", action="store_true", help="replace files that are already there")
    args = ap.parse_args(argv)

    user, password = os.environ.get("GMAIL_IMAP_USER"), os.environ.get("GMAIL_IMAP_PASS")
    if not user or not password:
        print("GMAIL_IMAP_USER and GMAIL_IMAP_PASS must be set in the environment", file=sys.stderr)
        return 2
    try:
        mapping = read_mapping(args.map)
        ids = read_ids(args.ids) if args.ids else list(mapping)
    except (FetchError, OSError) as err:
        print(f"error: {err}", file=sys.stderr)
        return 2
    jobs: list[tuple[str, str, str]] = []
    unmapped = 0
    for message_id in dict.fromkeys(ids):
        if message_id not in mapping:
            print(f"unmapped {message_id}: not in {args.map}")
            unmapped += 1
            continue
        jobs.append((message_id, *mapping[message_id]))

    try:
        conn = imaplib.IMAP4_SSL(HOST)
        conn.login(user, password)
    except (imaplib.IMAP4.error, OSError) as err:
        # The message is the server's reason (e.g. "Invalid credentials"), never the password.
        print(f"could not log in to {HOST} as {user}: {type(err).__name__}", file=sys.stderr)
        return 2
    try:
        code = run(conn, jobs, Path(args.out))
    except (FetchError, imaplib.IMAP4.error, OSError) as err:
        print(f"error: {err}", file=sys.stderr)
        return 2
    finally:
        try:
            conn.logout()
        except (imaplib.IMAP4.error, OSError):
            pass
    return 1 if unmapped else code


if __name__ == "__main__":
    sys.exit(main())
