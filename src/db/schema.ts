import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

/** Create/open the SQLite database and ensure the schema exists. */
export function openDb(path: string): DB {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  db.exec(`
    -- RSS feeds managed by the app.
    CREATE TABLE IF NOT EXISTS feeds (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      url             TEXT NOT NULL UNIQUE,
      title           TEXT NOT NULL DEFAULT '',
      folder          TEXT NOT NULL DEFAULT 'Uncategorized',
      last_fetched_at INTEGER,
      last_error      TEXT,
      created_at      INTEGER NOT NULL
    );

    -- Articles fetched from feeds.
    CREATE TABLE IF NOT EXISTS articles (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      feed_id      INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      guid         TEXT NOT NULL,
      title        TEXT NOT NULL DEFAULT '',
      url          TEXT NOT NULL DEFAULT '',
      author       TEXT,
      content_html TEXT NOT NULL DEFAULT '',
      published_at INTEGER,
      fetched_at   INTEGER NOT NULL,
      status       TEXT NOT NULL DEFAULT 'unread',
      UNIQUE(feed_id, guid)
    );

    CREATE INDEX IF NOT EXISTS articles_feed_status ON articles(feed_id, status);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS oauth_tokens (
      provider      TEXT PRIMARY KEY,
      access_token  TEXT NOT NULL,           -- AES-256-GCM encrypted
      refresh_token TEXT,                    -- AES-256-GCM encrypted
      expires_at    INTEGER NOT NULL,        -- epoch ms
      updated_at    INTEGER NOT NULL
    );

    -- Per-day curation: whether an article is included in that date's digest.
    CREATE TABLE IF NOT EXISTS article_selection (
      digest_date TEXT NOT NULL,             -- ISO date, e.g. 2026-06-07
      item_id     TEXT NOT NULL,
      folder      TEXT NOT NULL,             -- top-level folder name
      included    INTEGER NOT NULL DEFAULT 1,
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (digest_date, item_id)
    );

    -- Per-folder delivery cadence.
    CREATE TABLE IF NOT EXISTS folder_settings (
      folder       TEXT PRIMARY KEY,
      cadence      TEXT NOT NULL DEFAULT 'daily',  -- 'daily' | 'weekly'
      delivery_day INTEGER NOT NULL DEFAULT 0       -- 0=Sun…6=Sat; only used when cadence='weekly'
    );

    -- One row per digest run (per folder).
    CREATE TABLE IF NOT EXISTS run_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      digest_date   TEXT NOT NULL,
      folder        TEXT NOT NULL,
      started_at    INTEGER NOT NULL,
      finished_at   INTEGER,
      total_fetched INTEGER NOT NULL DEFAULT 0,
      included      INTEGER NOT NULL DEFAULT 0,
      excluded      INTEGER NOT NULL DEFAULT 0,
      duration_ms   INTEGER,
      status        TEXT NOT NULL DEFAULT 'running', -- running|sent|error
      error         TEXT
    );

    -- Per-article record within a run (drives the diagnostics page).
    CREATE TABLE IF NOT EXISTS article_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id          INTEGER NOT NULL REFERENCES run_log(id) ON DELETE CASCADE,
      item_id         TEXT NOT NULL,
      title           TEXT,
      url             TEXT,
      content_source  TEXT,   -- 'feed' | 'readability'
      failure_reason  TEXT,   -- 'paywall' | 'js-rendered' | 'http-error' | null
      extract_ms      INTEGER
    );
  `);
}
