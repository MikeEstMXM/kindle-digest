import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate, OWNER_USER_ID, type DB } from '../src/db/schema.js';
import { FeedRepo, FolderSettingsRepo, ArticleRepo } from '../src/db/feedRepos.js';
import { DeliveryRepo, SettingsRepo } from '../src/db/repositories.js';

/**
 * The live database predates accounts. Everything in it has to come through
 * the move to per-user tables: same rows, same ids (articles point at feeds by
 * id), nothing cascaded away, everything now owned by `mharm`.
 *
 * LEGACY_DDL is the schema exactly as it was before accounts (copied from the
 * periodical-delivery release, eeb2ecf), so this runs the real upgrade path.
 */
const LEGACY_DDL = `
  CREATE TABLE feeds (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    url             TEXT NOT NULL UNIQUE,
    title           TEXT NOT NULL DEFAULT '',
    folder          TEXT NOT NULL DEFAULT 'Uncategorized',
    last_fetched_at INTEGER,
    last_error      TEXT,
    created_at      INTEGER NOT NULL
  );
  CREATE TABLE articles (
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
  CREATE INDEX articles_feed_status ON articles(feed_id, status);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE oauth_tokens (
    provider TEXT PRIMARY KEY, access_token TEXT NOT NULL, refresh_token TEXT,
    expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE article_selection (
    digest_date TEXT NOT NULL, item_id TEXT NOT NULL, folder TEXT NOT NULL,
    included INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL,
    PRIMARY KEY (digest_date, item_id)
  );
  CREATE TABLE folder_settings (
    folder       TEXT PRIMARY KEY,
    cadence      TEXT NOT NULL DEFAULT 'daily',
    delivery_day INTEGER NOT NULL DEFAULT 0,
    max_articles INTEGER NOT NULL DEFAULT 20,
    cover_template TEXT,
    cover_theme TEXT NOT NULL DEFAULT 'dark'
  );
  CREATE TABLE run_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    digest_date   TEXT NOT NULL,
    folder        TEXT NOT NULL,
    started_at    INTEGER NOT NULL,
    finished_at   INTEGER,
    total_fetched INTEGER NOT NULL DEFAULT 0,
    included      INTEGER NOT NULL DEFAULT 0,
    excluded      INTEGER NOT NULL DEFAULT 0,
    duration_ms   INTEGER,
    status        TEXT NOT NULL DEFAULT 'running',
    error         TEXT,
    peak_rss_bytes INTEGER,
    epub_bytes     INTEGER,
    image_count    INTEGER,
    concurrency    INTEGER
  );
  CREATE TABLE article_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id          INTEGER NOT NULL REFERENCES run_log(id) ON DELETE CASCADE,
    item_id         TEXT NOT NULL,
    title           TEXT,
    url             TEXT,
    content_source  TEXT,
    failure_reason  TEXT,
    extract_ms      INTEGER
  );
  CREATE TABLE delivery (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    digest_date     TEXT NOT NULL,
    folder          TEXT NOT NULL,
    state           TEXT NOT NULL DEFAULT 'pending',
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    epub_path       TEXT,
    epub_bytes      INTEGER,
    article_count   INTEGER,
    message_id      TEXT,
    mobi_path       TEXT,
    last_error      TEXT,
    claimed_at      INTEGER,
    alerted_at      INTEGER,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    UNIQUE (digest_date, folder)
  );
  CREATE INDEX delivery_due ON delivery(state, next_attempt_at);
`;

const FEEDS = 33;
const ARTICLES_PER_FEED = 4;
const TABLES = [
  'feeds',
  'articles',
  'settings',
  'folder_settings',
  'delivery',
  'run_log',
  'article_log',
  'article_selection',
];

/** A database shaped and populated like the live one, foreign keys on as in production. */
function liveShapedDb(): DB {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(LEGACY_DDL);

  const addFeed = db.prepare(
    `INSERT INTO feeds (id, url, title, folder, last_fetched_at, last_error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const addArticle = db.prepare(
    `INSERT INTO articles (feed_id, guid, title, url, author, content_html, published_at, fetched_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unread')`,
  );
  const folders = ['Money', 'News', 'Tech', 'Uncategorized'];
  for (let i = 1; i <= FEEDS; i++) {
    // Ids are not contiguous: feeds were deleted over time.
    const id = i * 2;
    addFeed.run(
      id,
      `https://example.com/feed-${id}.xml`,
      `Feed ${id}`,
      folders[i % 4],
      1000 + i,
      i % 7 === 0 ? 'timeout' : null,
      500 + i,
    );
    for (let a = 0; a < ARTICLES_PER_FEED; a++) {
      addArticle.run(
        id,
        `g-${id}-${a}`,
        `Title ${id}/${a}`,
        `https://example.com/${id}/${a}`,
        'Author',
        `<p>body ${id} ${a}</p>`,
        2000 + a,
        3000 + a,
      );
    }
  }
  // AUTOINCREMENT had once handed out ids beyond what is still there.
  db.prepare("UPDATE sqlite_sequence SET seq = 500 WHERE name = 'feeds'").run();

  const setting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries({
    kindleEmail: 'me@kindle.com',
    deliveryTime: '06:30',
    timezone: 'Europe/London',
    smtpHost: 'smtp.example.com',
    smtpPort: '587',
    smtpSecure: 'false',
    smtpUser: 'me@example.com',
    smtpFrom: 'me@example.com',
    smtpPass: 'not-a-real-password',
    deliveryMode: 'download',
  })) {
    setting.run(k, v);
  }

  db.prepare(
    `INSERT INTO folder_settings (folder, cadence, delivery_day, max_articles, cover_template, cover_theme)
     VALUES ('Money', 'weekly', 5, 30, 'the-drop', 'light'), ('News', 'daily', 0, 20, NULL, 'dark')`,
  ).run();

  const addDelivery = db.prepare(
    `INSERT INTO delivery (digest_date, folder, state, attempts, next_attempt_at, epub_path, epub_bytes,
        article_count, message_id, mobi_path, last_error, created_at, updated_at)
     VALUES (?, ?, ?, 0, 1, ?, 1234, 5, NULL, ?, NULL, 1, 1)`,
  );
  for (let d = 1; d <= 30; d++) {
    const date = `2026-10-${String(d).padStart(2, '0')}`;
    addDelivery.run(
      date,
      'Money',
      'published',
      `/data/digests/money-${date}.epub`,
      `/data/kindle/money/money-${date}.mobi`,
    );
    addDelivery.run(date, 'News', 'sent', null, null);
  }

  const run = db
    .prepare(
      `INSERT INTO run_log (digest_date, folder, started_at, total_fetched, included, status, peak_rss_bytes)
       VALUES ('2026-10-01', 'Money', 1, 40, 20, 'built', 123456)`,
    )
    .run();
  db.prepare(
    `INSERT INTO article_log (run_id, item_id, title, content_source) VALUES (?, '8', 'T', 'feed')`,
  ).run(run.lastInsertRowid);
  db.prepare(
    `INSERT INTO article_selection (digest_date, item_id, folder, included, updated_at)
     VALUES ('2026-10-01', '8', 'Money', 0, 1)`,
  ).run();
  return db;
}

const count = (db: DB, table: string): number =>
  (db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number) ?? 0;

describe('accounts migration on a copy of a live-shaped database', () => {
  it('keeps every row of every table', () => {
    const db = liveShapedDb();
    const before = Object.fromEntries(TABLES.map((t) => [t, count(db, t)]));
    expect(before.feeds).toBe(FEEDS);
    expect(before.articles).toBe(FEEDS * ARTICLES_PER_FEED);
    expect(before.delivery).toBe(60);

    migrate(db);

    for (const [table, n] of Object.entries(before)) expect(count(db, table), table).toBe(n);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1); // switched back on
  });

  it('seeds exactly one account, mharm, with no password, and gives it everything', () => {
    const db = liveShapedDb();
    migrate(db);
    expect(db.prepare('SELECT id, username, password_hash FROM users').all()).toEqual([
      { id: OWNER_USER_ID, username: 'mharm', password_hash: null },
    ]);
    for (const table of ['feeds', 'settings', 'folder_settings', 'delivery']) {
      const owners = db.prepare(`SELECT DISTINCT user_id FROM ${table}`).pluck().all();
      expect(owners, table).toEqual([OWNER_USER_ID]);
    }
  });

  it('keeps feed ids, so articles still belong to the same feeds', () => {
    const db = liveShapedDb();
    migrate(db);
    const feeds = new FeedRepo(db).all();
    expect(feeds).toHaveLength(FEEDS);
    expect(Math.min(...feeds.map((f) => f.id))).toBe(2);
    const orphans = db
      .prepare(
        'SELECT COUNT(*) FROM articles a LEFT JOIN feeds f ON f.id = a.feed_id WHERE f.id IS NULL',
      )
      .pluck()
      .get();
    expect(orphans).toBe(0);
    const money = new ArticleRepo(db).recentByFolder('Money', 0);
    expect(money.length).toBeGreaterThan(0);
    expect(money[0].contentHtml).toMatch(/^<p>body \d+ \d<\/p>$/);
  });

  it('keeps settings, folder settings and delivery history readable through the repos', () => {
    const db = liveShapedDb();
    migrate(db);
    const settings = new SettingsRepo(db);
    expect(settings.get('timezone')).toBe('Europe/London');
    expect(settings.get('deliveryMode')).toBe('download');
    expect(Object.keys(settings.all())).toHaveLength(10);

    expect(new FolderSettingsRepo(db).get('Money')).toMatchObject({
      cadence: 'weekly',
      deliveryDay: 5,
      coverTemplate: 'the-drop',
      coverTheme: 'light',
    });

    const delivery = new DeliveryRepo(db);
    expect(delivery.recent(100)).toHaveLength(60);
    expect(delivery.find('2026-10-05', 'Money')).toMatchObject({
      state: 'published',
      mobi_path: '/data/kindle/money/money-2026-10-05.mobi',
    });
  });

  it('does not reuse ids the old tables had already handed out', () => {
    const db = liveShapedDb();
    migrate(db);
    expect(new FeedRepo(db).add('https://new.example/feed', 'New', 'News').id).toBeGreaterThan(500);
  });

  it('keeps the id counter even when the table is empty now', () => {
    const db = liveShapedDb();
    db.prepare('DELETE FROM delivery').run();
    db.prepare("UPDATE sqlite_sequence SET seq = 77 WHERE name = 'delivery'").run();
    migrate(db);
    const d = new DeliveryRepo(db);
    d.enqueue('2026-11-10', 'News');
    expect(d.find('2026-11-10', 'News')!.id).toBe(78);
  });

  it('is idempotent: a second run (every restart) changes nothing', () => {
    const db = liveShapedDb();
    migrate(db);
    const snapshot = JSON.stringify(db.prepare('SELECT * FROM feeds ORDER BY id').all());
    migrate(db);
    migrate(db);
    expect(JSON.stringify(db.prepare('SELECT * FROM feeds ORDER BY id').all())).toBe(snapshot);
    expect(count(db, 'users')).toBe(1);
    expect(count(db, 'articles')).toBe(FEEDS * ARTICLES_PER_FEED);
  });

  it('scopes uniqueness and queries per user, so a second account could be added later', () => {
    const db = liveShapedDb();
    migrate(db);
    const other = db
      .prepare("INSERT INTO users (username, created_at) VALUES ('someone', 1)")
      .run();
    const id = Number(other.lastInsertRowid);
    // The same URL and the same (date, folder) are fine for another user...
    expect(() =>
      new FeedRepo(db, id).add('https://example.com/feed-2.xml', 'Mine', 'News'),
    ).not.toThrow();
    expect(new DeliveryRepo(db, id).enqueue('2026-10-05', 'Money')).toBe(true);
    // ...and each user sees only their own...
    expect(new FeedRepo(db, id).all()).toHaveLength(1);
    expect(new FeedRepo(db).all()).toHaveLength(FEEDS);
    expect(new DeliveryRepo(db, id).recent(100)).toHaveLength(1);
    expect(new SettingsRepo(db, id).all()).toEqual({});
    // ...but not twice for the same user.
    expect(() => new FeedRepo(db).add('https://example.com/feed-2.xml', 'Dup', 'News')).toThrow();
  });

  it('does not refuse to start over dangling rows that were already there', () => {
    const db = liveShapedDb();
    db.pragma('foreign_keys = OFF');
    db.prepare(
      "INSERT INTO articles (feed_id, guid, fetched_at) VALUES (99999, 'orphan', 1)",
    ).run();
    db.pragma('foreign_keys = ON');
    expect(() => migrate(db)).not.toThrow();
    expect(count(db, 'feeds')).toBe(FEEDS);
    expect(count(db, 'articles')).toBe(FEEDS * ARTICLES_PER_FEED + 1);
  });

  it('upgrades a much older database too (before delivery, cadence and cover columns)', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE feeds (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL DEFAULT '',
        folder TEXT NOT NULL DEFAULT 'Uncategorized', last_fetched_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE articles (id INTEGER PRIMARY KEY AUTOINCREMENT, feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
        guid TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', author TEXT, content_html TEXT NOT NULL DEFAULT '',
        published_at INTEGER, fetched_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'unread', UNIQUE(feed_id, guid));
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE folder_settings (folder TEXT PRIMARY KEY, cadence TEXT NOT NULL DEFAULT 'daily', delivery_day INTEGER NOT NULL DEFAULT 0);
      INSERT INTO feeds (url, title, folder, created_at) VALUES ('https://a/feed', 'A', 'News', 1);
      INSERT INTO articles (feed_id, guid, fetched_at) VALUES (1, 'g', 1);
      INSERT INTO settings VALUES ('timezone', 'UTC');
      INSERT INTO folder_settings (folder, cadence, delivery_day) VALUES ('News', 'weekly', 3);
    `);
    migrate(db);
    expect(count(db, 'articles')).toBe(1);
    expect(new FeedRepo(db).all()).toHaveLength(1);
    expect(new SettingsRepo(db).get('timezone')).toBe('UTC');
    expect(new FolderSettingsRepo(db).get('News')).toMatchObject({
      cadence: 'weekly',
      deliveryDay: 3,
      coverTheme: 'dark',
    });
  });

  it('creates a fresh database with the owner and no data', () => {
    const db = new Database(':memory:');
    migrate(db);
    expect(db.prepare('SELECT username FROM users').pluck().all()).toEqual(['mharm']);
    expect(count(db, 'feeds')).toBe(0);
  });
});
