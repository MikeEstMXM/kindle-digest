"""Tests for fetch-sent-digests.py and latest-sent.py (no network: a fake IMAP connection).

    python3 -m unittest scripts/test_fetch_sent_digests.py
"""
import importlib.util
import io
import os
import sqlite3
import tempfile
import unittest
import zipfile
from contextlib import redirect_stdout, redirect_stderr
from email.message import EmailMessage
from pathlib import Path
from unittest import mock

HERE = Path(__file__).parent


def load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


fetch = load("fetch_sent_digests", "fetch-sent-digests.py")
latest = load("latest_sent", "latest-sent.py")


def epub_bytes() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", "<container/>")
    return buf.getvalue()


def message_with(attachment: bytes | None, name: str = "Money.epub") -> bytes:
    msg = EmailMessage()
    msg["Subject"] = "Money — 2026-11-02"
    msg.set_content("digest")
    if attachment is not None:
        msg.add_attachment(attachment, maintype="application", subtype="epub+zip", filename=name)
    return msg.as_bytes()


class FakeImap:
    """Just enough of imaplib.IMAP4_SSL; records every command so read-only-ness can be asserted."""

    def __init__(self, mailbox: dict[str, bytes], sent_name: str = '"[Gmail]/Sent Mail"'):
        self.mailbox = mailbox  # message-id -> raw message
        self.sent_name = sent_name
        self.commands: list[str] = []
        self.readonly: bool | None = None

    def select(self, name, readonly=False):
        self.commands.append(f"SELECT {name}")
        self.readonly = readonly
        return ("OK", [b"1"]) if name == self.sent_name else ("NO", [b"nope"])

    def list(self):
        self.commands.append("LIST")
        return ("OK", [b'(\\HasNoChildren \\Sent) "/" "[Gmail]/Gesendet"'])

    def uid(self, cmd, *args):
        self.commands.append(f"UID {cmd}")
        if cmd == "SEARCH":
            term = args[-1].strip('"')
            hits = [k for k in self.mailbox if term in k]
            return "OK", [b" ".join(str(list(self.mailbox).index(k) + 1).encode() for k in hits)]
        if cmd == "FETCH":
            key = list(self.mailbox)[int(args[0]) - 1]
            return "OK", [(b"1 (BODY[] {1}", self.mailbox[key]), b")"]
        raise AssertionError(f"unexpected command {cmd}")


class FetchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name) / "out"
        self.lines: list[str] = []

    def tearDown(self):
        self.tmp.cleanup()

    def run_jobs(self, conn, jobs, **kw):
        return fetch.run(conn, jobs, self.out, say=self.lines.append, **kw)

    def test_saves_attachment_under_folder_and_date(self):
        conn = FakeImap({"abc@gmail.com": message_with(epub_bytes())})
        code = self.run_jobs(conn, [("<abc@gmail.com>", "Money", "2026-11-02")])
        self.assertEqual(code, 0)
        self.assertTrue(fetch.looks_like_epub(self.out / "Money-2026-11-02.epub"))
        self.assertTrue(self.lines[0].startswith("found "))

    def test_reports_missing_and_message_without_attachment(self):
        conn = FakeImap({"bare@gmail.com": message_with(None)})
        code = self.run_jobs(
            conn,
            [("<nope@gmail.com>", "News", "2026-11-08"), ("<bare@gmail.com>", "Science", "2026-11-01")],
        )
        self.assertEqual(code, 1)
        self.assertEqual([l.split()[0] for l in self.lines[:2]], ["missing", "missing"])
        self.assertEqual(list(self.out.iterdir()), [])

    def test_rejects_attachment_that_is_not_an_epub(self):
        conn = FakeImap({"x@gmail.com": message_with(b"not a zip")})
        self.assertEqual(self.run_jobs(conn, [("<x@gmail.com>", "Money", "2026-11-02")]), 1)
        self.assertTrue(self.lines[0].startswith("bad "))
        self.assertEqual(list(self.out.iterdir()), [])  # no half-written file left behind

    def test_is_read_only(self):
        conn = FakeImap({"abc@gmail.com": message_with(epub_bytes())})
        self.run_jobs(conn, [("<abc@gmail.com>", "Money", "2026-11-02")])
        self.assertTrue(conn.readonly, "mailbox must be opened with EXAMINE (readonly=True)")
        verbs = {c.split()[0] + " " + (c.split()[1] if c.startswith("UID") else "") for c in conn.commands}
        self.assertEqual(verbs, {"SELECT ", "UID SEARCH", "UID FETCH"})  # no STORE / COPY / EXPUNGE / APPEND

    def test_falls_back_to_the_mailbox_gmail_marks_sent(self):
        conn = FakeImap({"abc@gmail.com": message_with(epub_bytes())}, sent_name='"[Gmail]/Gesendet"')
        self.assertEqual(self.run_jobs(conn, [("<abc@gmail.com>", "Money", "2026-11-02")]), 0)

    def test_existing_file_is_kept_unless_overwrite(self):
        conn = FakeImap({"abc@gmail.com": message_with(epub_bytes())})
        self.out.mkdir(parents=True)
        (self.out / "Money-2026-11-02.epub").write_bytes(b"old")
        self.assertEqual(self.run_jobs(conn, [("<abc@gmail.com>", "Money", "2026-11-02")]), 0)
        self.assertEqual((self.out / "Money-2026-11-02.epub").read_bytes(), b"old")
        self.assertTrue(self.lines[0].startswith("exists"))
        self.run_jobs(conn, [("<abc@gmail.com>", "Money", "2026-11-02")], overwrite=True)
        self.assertTrue(fetch.looks_like_epub(self.out / "Money-2026-11-02.epub"))

    def test_file_names_cannot_leave_the_output_dir(self):
        self.assertEqual(fetch.output_name("../../etc", "2026-11-02"), "etc-2026-11-02.epub")
        self.assertEqual(fetch.output_name("Culture & Arts", "2026-11-02"), "Culture-Arts-2026-11-02.epub")

    def test_search_term_quotes_and_rejects_odd_ids(self):
        self.assertEqual(fetch.search_term("<a@b.c>"), '"a@b.c"')
        with self.assertRaises(fetch.FetchError):
            fetch.search_term('<a"b@c>')

    def test_mapping_survives_commas_bom_and_unicode_folders(self):
        p = Path(self.tmp.name) / "map2.csv"
        p.write_bytes('\ufeff<a@b>,"Tech, AI",2026-11-02\n<c@d>,Café,2026-11-03\n'.encode("utf-8"))
        self.assertEqual(
            fetch.read_mapping(str(p)),
            {"<a@b>": ("Tech, AI", "2026-11-02"), "<c@d>": ("Café", "2026-11-03")},
        )
        self.assertEqual(fetch.output_name("Café", "2026-11-03"), "Café-2026-11-03.epub")

    def test_epub_with_trailing_newline_in_mimetype_is_accepted(self):
        p = Path(self.tmp.name) / "nl.epub"
        with zipfile.ZipFile(p, "w") as z:
            z.writestr("mimetype", "application/epub+zip\n", compress_type=zipfile.ZIP_STORED)
        self.assertTrue(fetch.looks_like_epub(p))

    def test_mapping_file(self):
        p = Path(self.tmp.name) / "map.csv"
        p.write_text("# comment\n<a@b>,Money,2026-11-02\n\n<c@d>,News,2026-11-08\n")
        self.assertEqual(fetch.read_mapping(str(p)), {"<a@b>": ("Money", "2026-11-02"), "<c@d>": ("News", "2026-11-08")})
        p.write_text("<a@b>,Money,yesterday\n")
        with self.assertRaises(fetch.FetchError):
            fetch.read_mapping(str(p))


class MainTests(unittest.TestCase):
    def test_needs_credentials_and_never_echoes_them(self):
        err = io.StringIO()
        with mock.patch.dict(os.environ, {}, clear=True), redirect_stderr(err):
            self.assertEqual(fetch.main(["--map", "x", "--out", "y"]), 2)
        self.assertIn("GMAIL_IMAP_PASS", err.getvalue())

    def test_login_failure_does_not_print_the_password(self):
        secret = "s3cr3t-app-password"
        with tempfile.TemporaryDirectory() as d:
            m = Path(d) / "map.csv"
            m.write_text("<a@b>,Money,2026-11-02\n")
            boom = mock.MagicMock()
            boom.login.side_effect = fetch.imaplib.IMAP4.error(f"[AUTHENTICATIONFAILED] Invalid credentials {secret}")
            out, err = io.StringIO(), io.StringIO()
            env = {"GMAIL_IMAP_USER": "me@gmail.com", "GMAIL_IMAP_PASS": secret}
            with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(
                fetch.imaplib, "IMAP4_SSL", return_value=boom
            ), redirect_stdout(out), redirect_stderr(err):
                self.assertEqual(fetch.main(["--map", str(m), "--out", str(Path(d) / "o")]), 2)
            self.assertNotIn(secret, out.getvalue() + err.getvalue())


class LatestSentTests(unittest.TestCase):
    def test_output_round_trips_through_the_fetch_script_even_with_commas(self):
        with tempfile.TemporaryDirectory() as d:
            db = Path(d) / "x.sqlite"
            con = sqlite3.connect(db)
            con.execute("CREATE TABLE delivery (id INTEGER PRIMARY KEY, digest_date TEXT, folder TEXT, state TEXT, message_id TEXT)")
            con.execute("INSERT INTO delivery (digest_date, folder, state, message_id) VALUES ('2026-11-03','Tech, AI','sent','<c,d@h>')")
            con.commit()
            con.close()
            out = io.StringIO()
            with redirect_stdout(out):
                self.assertEqual(latest.main([str(db)]), 0)
            (Path(d) / "map.csv").write_text(out.getvalue(), encoding="utf-8")
            self.assertEqual(fetch.read_mapping(str(Path(d) / "map.csv")), {"<c,d@h>": ("Tech, AI", "2026-11-03")})

    def test_newest_per_folder_sent_only(self):
        with tempfile.TemporaryDirectory() as d:
            db = Path(d) / "x.sqlite"
            con = sqlite3.connect(db)
            con.execute("CREATE TABLE delivery (id INTEGER PRIMARY KEY, digest_date TEXT, folder TEXT, state TEXT, message_id TEXT)")
            rows = [(f"2026-11-{n:02d}", "Money", "sent", f"<m{n}@x>") for n in range(1, 13)]
            rows += [("2026-11-20", "Money", "failed", "<failed@x>"), ("2026-11-21", "Money", "sent", None)]
            rows += [("2026-11-05", "News", "sent", "<n5@x>")]
            con.executemany("INSERT INTO delivery (digest_date, folder, state, message_id) VALUES (?,?,?,?)", rows)
            con.commit()
            con.close()
            got = latest.latest_sent(str(db), 10)
            money = [r for r in got if r[1] == "Money"]
            self.assertEqual(len(money), 10)
            self.assertEqual(money[0], ("<m12@x>", "Money", "2026-11-12"))
            self.assertEqual(money[-1][2], "2026-11-03")
            self.assertEqual([r for r in got if r[1] == "News"], [("<n5@x>", "News", "2026-11-05")])
            self.assertNotIn("<failed@x>", [r[0] for r in got])
            # Read-only: the file is untouched.
            with self.assertRaises(sqlite3.OperationalError):
                sqlite3.connect(f"file:{db}?mode=ro", uri=True).execute("DELETE FROM delivery")


if __name__ == "__main__":
    unittest.main()
