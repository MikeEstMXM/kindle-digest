import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

/** The one account. Seeded by migrate(); there is no sign-up. */
export const OWNER_USERNAME = 'mharm';
/**
 * Its id. migrate() seeds the account before anything else, so on every
 * database (fresh or migrated) the owner is user 1; the repositories default
 * to it. createContext() still looks the id up by name rather than assuming.
 */
export const OWNER_USER_ID = 1;

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

// ─── Tables that belong to a user ───────────────────────────────────────────
// Defined as functions of the table name so the same text creates a fresh table
// and the replacement table in the ownership migration below.

const feedsDdl = (t: string): string => `
  CREATE TABLE IF NOT EXISTS ${t} (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    url             TEXT NOT NULL,
    title           TEXT NOT NULL DEFAULT '',
    folder          TEXT NOT NULL DEFAULT 'Uncategorized',
    last_fetched_at INTEGER,
    last_error      TEXT,
    created_at      INTEGER NOT NULL,
    UNIQUE (user_id, url)
  )`;

const settingsDdl = (t: string): string => `
  CREATE TABLE IF NOT EXISTS ${t} (
    user_id INTEGER NOT NULL REFERENCES users(id),
    key     TEXT NOT NULL,
    value   TEXT,
    PRIMARY KEY (user_id, key)
  )`;

// Per-folder delivery cadence.
const folderSettingsDdl = (t: string): string => `
  CREATE TABLE IF NOT EXISTS ${t} (
    user_id        INTEGER NOT NULL REFERENCES users(id),
    folder         TEXT NOT NULL,
    cadence        TEXT NOT NULL DEFAULT 'daily',  -- 'daily' | 'weekly'
    delivery_day   INTEGER NOT NULL DEFAULT 0,     -- 0=Sun…6=Sat; only used when cadence='weekly'
    max_articles   INTEGER NOT NULL DEFAULT 20,    -- cap on articles per digest
    cover_template TEXT,
    cover_theme    TEXT NOT NULL DEFAULT 'dark',
    PRIMARY KEY (user_id, folder)
  )`;

// Durable delivery outbox: one row per (date, folder) that must be delivered.
// Survives crashes and restarts; the worker drives it through the state
// machine. This — not run_log — is the truth about delivery.
const deliveryDdl = (t: string): string => `
  CREATE TABLE IF NOT EXISTS ${t} (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    digest_date     TEXT NOT NULL,
    folder          TEXT NOT NULL,
    -- pending|building|built|sending|sent|published|failed|skipped
    -- (sent = emailed; published = MOBI is in the issue archive)
    state           TEXT NOT NULL DEFAULT 'pending',
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    epub_path       TEXT,     -- built artifact on the volume; retries reuse it
    epub_bytes      INTEGER,  -- diagnostics only, nothing is keyed off this
    article_count   INTEGER,
    message_id      TEXT,     -- SMTP messageId — proof the server accepted it
    last_error      TEXT,
    claimed_at      INTEGER,  -- set while in building/sending; drives stale sweep
    alerted_at      INTEGER,  -- failure alert sent once, never loops
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    mobi_path       TEXT,     -- published periodical MOBI (download mode)
    UNIQUE (user_id, digest_date, folder)
  )`;

/** Tables that predate accounts: name, DDL, and the columns copied across. */
const OWNED_TABLES: { table: string; ddl: (t: string) => string; columns: string[] }[] = [
  {
    table: 'feeds',
    ddl: feedsDdl,
    columns: ['id', 'url', 'title', 'folder', 'last_fetched_at', 'last_error', 'created_at'],
  },
  { table: 'settings', ddl: settingsDdl, columns: ['key', 'value'] },
  {
    table: 'folder_settings',
    ddl: folderSettingsDdl,
    columns: ['folder', 'cadence', 'delivery_day', 'max_articles', 'cover_template', 'cover_theme'],
  },
  {
    table: 'delivery',
    ddl: deliveryDdl,
    columns: [
      'id',
      'digest_date',
      'folder',
      'state',
      'attempts',
      'next_attempt_at',
      'epub_path',
      'epub_bytes',
      'article_count',
      'message_id',
      'last_error',
      'claimed_at',
      'alerted_at',
      'created_at',
      'updated_at',
      'mobi_path',
    ],
  },
];

const columnsOf = (db: DB, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

export function migrate(db: DB): void {
  db.exec(`
    -- The accounts. password_hash is NULL until the owner sets one at /setup.
    CREATE TABLE IF NOT EXISTS users (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      username            TEXT NOT NULL UNIQUE,
      password_hash       TEXT,
      created_at          INTEGER NOT NULL,
      password_changed_at INTEGER
    );

    -- Login sessions, server side. Only a hash of the cookie value is stored,
    -- so a leaked database cannot be replayed as a session.
    CREATE TABLE IF NOT EXISTS sessions (
      id_hash      TEXT PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_token   TEXT NOT NULL,
      remember     INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      ip           TEXT,
      user_agent   TEXT
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);

    -- Failed password attempts; drives the login rate limit.
    CREATE TABLE IF NOT EXISTS login_failures (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      ip       TEXT NOT NULL,
      username TEXT,
      at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS login_failures_ip_at ON login_failures(ip, at);

    -- Published Kindle issues: one row per .mobi in KINDLE_DIR.
    CREATE TABLE IF NOT EXISTS issues (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      slug       TEXT NOT NULL,            -- directory name under KINDLE_DIR
      folder     TEXT NOT NULL,            -- the folder's real name, for display
      issue_date TEXT NOT NULL,            -- ISO date
      file_name  TEXT NOT NULL,            -- <slug>-<date>.mobi
      bytes      INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (user_id, slug, issue_date)
    );
  `);

  // The owner account must exist before any table can point at it.
  db.prepare('INSERT OR IGNORE INTO users (username, created_at) VALUES (?, ?)').run(
    OWNER_USERNAME,
    Date.now(),
  );

  db.exec(`
    -- RSS feeds managed by the app.
    ${feedsDdl('feeds')};

    -- Articles fetched from feeds (owned through their feed).
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

    ${settingsDdl('settings')};

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

    ${folderSettingsDdl('folder_settings')};

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
      status        TEXT NOT NULL DEFAULT 'running', -- running|built|error
      error         TEXT,
      -- Build cost; NULL for runs recorded before this was measured.
      peak_rss_bytes INTEGER,
      epub_bytes     INTEGER,
      image_count    INTEGER,
      concurrency    INTEGER
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

    ${deliveryDdl('delivery')};
  `);

  // Idempotent column migrations for existing DBs. (These run on the pre-account
  // table shapes; adoptOwner() below rebuilds those tables afterwards.)
  if (!columnsOf(db, 'delivery').includes('mobi_path')) {
    db.exec('ALTER TABLE delivery ADD COLUMN mobi_path TEXT');
  }
  const cols = columnsOf(db, 'folder_settings');
  if (!cols.includes('max_articles')) {
    db.exec('ALTER TABLE folder_settings ADD COLUMN max_articles INTEGER NOT NULL DEFAULT 20');
  }
  if (!cols.includes('cover_template')) {
    db.exec('ALTER TABLE folder_settings ADD COLUMN cover_template TEXT');
  }
  if (!cols.includes('cover_theme')) {
    db.exec("ALTER TABLE folder_settings ADD COLUMN cover_theme TEXT NOT NULL DEFAULT 'dark'");
  }

  // Build cost, recorded per run so real digests can be compared over time and
  // against the synthetic benchmark. Nullable: rows written before this
  // migration have no measurement, and absent must stay distinguishable from
  // zero.
  const runCols = columnsOf(db, 'run_log');
  if (!runCols.includes('peak_rss_bytes')) {
    db.exec('ALTER TABLE run_log ADD COLUMN peak_rss_bytes INTEGER');
  }
  if (!runCols.includes('epub_bytes')) {
    db.exec('ALTER TABLE run_log ADD COLUMN epub_bytes INTEGER');
  }
  if (!runCols.includes('image_count')) {
    db.exec('ALTER TABLE run_log ADD COLUMN image_count INTEGER');
  }
  if (!runCols.includes('concurrency')) {
    db.exec('ALTER TABLE run_log ADD COLUMN concurrency INTEGER');
  }

  adoptOwner(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS delivery_due ON delivery(state, next_attempt_at);
    CREATE INDEX IF NOT EXISTS feeds_user_folder ON feeds(user_id, folder);
    CREATE INDEX IF NOT EXISTS issues_user_slug ON issues(user_id, slug, issue_date);
  `);
}

/**
 * Give every row that predates accounts to the owner.
 *
 * SQLite cannot add a NOT NULL column that references another table, nor change
 * a UNIQUE/PRIMARY KEY, so each table is rebuilt: create the new shape, copy
 * every row across (ids preserved — `articles.feed_id` points at feeds.id),
 * drop the old table, rename. That is SQLite's documented procedure, and it
 * needs foreign keys OFF: with them on, dropping `feeds` would cascade-delete
 * every article. The pragma cannot change inside a transaction, hence the
 * wrapper, and the foreign-key check before commit proves nothing was orphaned.
 * A table that already has `user_id` is left alone, so this is idempotent.
 */
function adoptOwner(db: DB): void {
  const pending = OWNED_TABLES.filter((t) => !columnsOf(db, t.table).includes('user_id'));
  if (pending.length === 0) return;

  const fkWasOn = db.pragma('foreign_keys', { simple: true }) === 1;
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      // Dangling rows that were already there are not this migration's to fix
      // (and must not stop the app starting); only new ones are its fault.
      const danglingBefore = (db.pragma('foreign_key_check') as unknown[]).length;
      for (const { table, ddl, columns } of pending) {
        const tmp = `${table}__new`;
        const seq = db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(table) as
          | { seq: number }
          | undefined;
        db.exec(`DROP TABLE IF EXISTS ${tmp}`);
        db.exec(ddl(tmp));
        const list = columns.join(', ');
        db.prepare(`INSERT INTO ${tmp} (user_id, ${list}) SELECT ?, ${list} FROM ${table}`).run(
          OWNER_USER_ID,
        );
        db.exec(`DROP TABLE ${table}`);
        db.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);
        // AUTOINCREMENT remembers the highest id ever used, deleted rows
        // included; keep that so an id is never handed out twice.
        if (seq) {
          db.prepare('UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?').run(
            seq.seq,
            table,
          );
        }
      }
      const danglingAfter = (db.pragma('foreign_key_check') as unknown[]).length;
      if (danglingAfter > danglingBefore) {
        throw new Error(
          `ownership migration orphaned ${danglingAfter - danglingBefore} row(s); rolled back`,
        );
      }
    })();
  } finally {
    if (fkWasOn) db.pragma('foreign_keys = ON');
  }
}
