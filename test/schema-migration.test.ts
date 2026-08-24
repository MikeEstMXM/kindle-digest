import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/schema.js';

/**
 * The production DB on the Fly volume predates the build-cost columns, so
 * migrate() has to add them to a populated table without disturbing what is
 * already there. This is the failure that would only show up on deploy.
 */
function legacyDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
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
      error         TEXT
    );
  `);
  db.prepare(
    `INSERT INTO run_log (digest_date, folder, started_at, total_fetched, included, status)
     VALUES ('2026-08-23', 'News', 1000, 200, 157, 'built')`,
  ).run();
  return db;
}

const columns = (db: Database.Database, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

describe('run_log build-cost migration', () => {
  it('adds the new columns to an existing populated table', () => {
    const db = legacyDb();
    expect(columns(db, 'run_log')).not.toContain('peak_rss_bytes');

    migrate(db);

    const cols = columns(db, 'run_log');
    for (const c of ['peak_rss_bytes', 'epub_bytes', 'image_count', 'concurrency']) {
      expect(cols).toContain(c);
    }
  });

  it('preserves existing rows, leaving unmeasured runs NULL rather than 0', () => {
    const db = legacyDb();
    migrate(db);

    const row = db.prepare('SELECT * FROM run_log WHERE id = 1').get() as Record<string, unknown>;
    expect(row.folder).toBe('News');
    expect(row.included).toBe(157);
    expect(row.status).toBe('built');
    // Absent must stay distinguishable from a real measurement of zero.
    expect(row.peak_rss_bytes).toBeNull();
    expect(row.concurrency).toBeNull();
  });

  it('is idempotent — a second migrate() does not throw on duplicate columns', () => {
    const db = legacyDb();
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM run_log').get()).toEqual({ n: 1 });
  });

  it('creates the columns on a fresh database too', () => {
    const db = new Database(':memory:');
    migrate(db);
    expect(columns(db, 'run_log')).toContain('peak_rss_bytes');
  });
});
