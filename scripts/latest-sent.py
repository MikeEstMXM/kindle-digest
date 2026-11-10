#!/usr/bin/env python3
"""List the newest sent digests per folder from a kindle-digest database.

Reads the `delivery` table (state = 'sent') of a SQLite copy of the app's
database, read-only, and prints one `message_id,folder,date` line per issue:
the mapping file scripts/fetch-sent-digests.py takes.

If the database is a copy of a live one, copy its `-wal` file next to it too
(and `-shm`): the newest sends may still be in the WAL, and are missing without it.

    python3 scripts/latest-sent.py DB.sqlite                 # newest 10 per folder
    python3 scripts/latest-sent.py DB.sqlite --limit 5
    python3 scripts/latest-sent.py DB.sqlite --ids           # only the Message-IDs

Plain SQL, if you would rather run it yourself:

    SELECT message_id, folder, digest_date FROM (
      SELECT message_id, folder, digest_date,
             ROW_NUMBER() OVER (PARTITION BY folder ORDER BY digest_date DESC, id DESC) AS rn
      FROM delivery
      WHERE state = 'sent' AND message_id IS NOT NULL AND message_id <> '')
    WHERE rn <= 10 ORDER BY folder, digest_date DESC;
"""
import argparse
import csv
import sqlite3
import sys
from pathlib import Path

QUERY = """
SELECT message_id, folder, digest_date FROM (
  SELECT message_id, folder, digest_date,
         ROW_NUMBER() OVER (PARTITION BY folder ORDER BY digest_date DESC, id DESC) AS rn
  FROM delivery
  WHERE state = 'sent' AND message_id IS NOT NULL AND message_id <> ''
)
WHERE rn <= ?
ORDER BY folder, digest_date DESC
"""


def latest_sent(db_path: str, limit: int = 10) -> list[tuple[str, str, str]]:
    """(message_id, folder, digest_date) for the newest `limit` sent digests of each folder."""
    # mode=ro: opening a copy of the live database must never write to it.
    con = sqlite3.connect(f"file:{Path(db_path).resolve()}?mode=ro", uri=True)
    try:
        return [tuple(r) for r in con.execute(QUERY, (limit,))]
    finally:
        con.close()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Newest sent digests per folder, as message_id,folder,date lines.")
    ap.add_argument("db", help="path to a copy of the kindle-digest SQLite database")
    ap.add_argument("--limit", type=int, default=10, help="issues per folder (default 10)")
    ap.add_argument("--ids", action="store_true", help="print only the Message-IDs, one per line")
    args = ap.parse_args(argv)
    if args.limit < 1:
        ap.error("--limit must be at least 1")
    try:
        rows = latest_sent(args.db, args.limit)
    except sqlite3.Error as err:
        print(f"could not read {args.db}: {err}", file=sys.stderr)
        return 1
    writer = csv.writer(sys.stdout, lineterminator="\n")  # quotes a folder name that has a comma
    for message_id, folder, date in rows:
        if args.ids:
            print(message_id)
        else:
            writer.writerow([message_id, folder, date])
    return 0


if __name__ == "__main__":
    sys.exit(main())
