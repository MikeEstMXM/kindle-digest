import type { DB } from './schema.js';
import { encrypt, decrypt } from '../config/crypto.js';

// ─── Settings ───────────────────────────────────────────────────────────────

export interface AppSettings {
  kindleEmail?: string;
  deliveryTime?: string; // HH:mm
  timezone?: string;
  smtpHost?: string;
  smtpPort?: string;
  smtpSecure?: string;
  smtpUser?: string;
  smtpPass?: string;
  smtpFrom?: string;
}

export class SettingsRepo {
  constructor(private db: DB) {}

  get(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  all(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as {
      key: string;
      value: string;
    }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }
}

// ─── OAuth tokens ────────────────────────────────────────────────────────────

export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // epoch ms
}

export class TokenRepo {
  constructor(
    private db: DB,
    private encryptionKey: string,
  ) {}

  save(provider: string, tokens: StoredTokens): void {
    this.db
      .prepare(
        `INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at, updated_at)
         VALUES (@provider, @access, @refresh, @expires, @now)
         ON CONFLICT(provider) DO UPDATE SET
           access_token  = excluded.access_token,
           refresh_token = excluded.refresh_token,
           expires_at    = excluded.expires_at,
           updated_at    = excluded.updated_at`,
      )
      .run({
        provider,
        access: encrypt(tokens.accessToken, this.encryptionKey),
        refresh: tokens.refreshToken ? encrypt(tokens.refreshToken, this.encryptionKey) : null,
        expires: tokens.expiresAt,
        now: Date.now(),
      });
  }

  load(provider: string): StoredTokens | undefined {
    const row = this.db.prepare('SELECT * FROM oauth_tokens WHERE provider = ?').get(provider) as
      | { access_token: string; refresh_token: string | null; expires_at: number }
      | undefined;
    if (!row) return undefined;
    return {
      accessToken: decrypt(row.access_token, this.encryptionKey),
      refreshToken: row.refresh_token ? decrypt(row.refresh_token, this.encryptionKey) : undefined,
      expiresAt: row.expires_at,
    };
  }

  clear(provider: string): void {
    this.db.prepare('DELETE FROM oauth_tokens WHERE provider = ?').run(provider);
  }
}

// ─── Article selection (curation) ────────────────────────────────────────────

export class SelectionRepo {
  constructor(private db: DB) {}

  /** Default = included. Returns false only if explicitly excluded. */
  isIncluded(digestDate: string, itemId: string): boolean {
    const row = this.db
      .prepare('SELECT included FROM article_selection WHERE digest_date = ? AND item_id = ?')
      .get(digestDate, itemId) as { included: number } | undefined;
    return row ? row.included === 1 : true;
  }

  setIncluded(digestDate: string, itemId: string, folder: string, included: boolean): void {
    this.db
      .prepare(
        `INSERT INTO article_selection (digest_date, item_id, folder, included, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(digest_date, item_id) DO UPDATE SET
           included = excluded.included, updated_at = excluded.updated_at`,
      )
      .run(digestDate, itemId, folder, included ? 1 : 0, Date.now());
  }

  excludedIds(digestDate: string): Set<string> {
    const rows = this.db
      .prepare('SELECT item_id FROM article_selection WHERE digest_date = ? AND included = 0')
      .all(digestDate) as { item_id: string }[];
    return new Set(rows.map((r) => r.item_id));
  }

  renameFolder(oldName: string, newName: string): void {
    this.db
      .prepare('UPDATE article_selection SET folder = ? WHERE folder = ?')
      .run(newName, oldName);
  }
}

// ─── Run + article logs (diagnostics) ────────────────────────────────────────

export interface ArticleLogEntry {
  itemId: string;
  title?: string;
  url?: string;
  contentSource?: 'feed' | 'readability';
  failureReason?: 'paywall' | 'js-rendered' | 'http-error' | null;
  extractMs?: number;
}

/** Build cost for one run. All optional: an errored build may have measured none. */
export interface RunMetrics {
  peakRssBytes?: number;
  epubBytes?: number;
  imageCount?: number;
  concurrency?: number;
}

export class RunLogRepo {
  constructor(private db: DB) {}

  start(digestDate: string, folder: string, totalFetched: number, included: number): number {
    const info = this.db
      .prepare(
        `INSERT INTO run_log (digest_date, folder, started_at, total_fetched, included, excluded, status)
         VALUES (?, ?, ?, ?, ?, ?, 'running')`,
      )
      .run(digestDate, folder, Date.now(), totalFetched, included, totalFetched - included);
    return Number(info.lastInsertRowid);
  }

  addArticle(runId: number, e: ArticleLogEntry): void {
    this.db
      .prepare(
        `INSERT INTO article_log
           (run_id, item_id, title, url, content_source, failure_reason, extract_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        e.itemId,
        e.title ?? null,
        e.url ?? null,
        e.contentSource ?? null,
        e.failureReason ?? null,
        e.extractMs ?? null,
      );
  }

  /**
   * Close out a run. `built` means an EPUB was produced — it says nothing
   * about delivery; `delivery.state` is the authority on whether mail was
   * accepted. (This used to be hardcoded to 'sent' at the end of the build,
   * which made a failed send indistinguishable from a delivered digest.)
   */
  finish(
    runId: number,
    status: 'built' | 'error',
    durationMs: number,
    error?: string,
    metrics?: RunMetrics,
  ): void {
    this.db
      .prepare(
        `UPDATE run_log
            SET finished_at = ?, duration_ms = ?, status = ?, error = ?,
                peak_rss_bytes = ?, epub_bytes = ?, image_count = ?, concurrency = ?
          WHERE id = ?`,
      )
      .run(
        Date.now(),
        durationMs,
        status,
        error ?? null,
        metrics?.peakRssBytes ?? null,
        metrics?.epubBytes ?? null,
        metrics?.imageCount ?? null,
        metrics?.concurrency ?? null,
        runId,
      );
  }

  articles(runId: number): ArticleLogEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM article_log WHERE run_id = ? ORDER BY id')
      .all(runId) as Record<string, unknown>[];
    return rows.map((r) => ({
      itemId: r.item_id as string,
      title: (r.title as string) ?? undefined,
      url: (r.url as string) ?? undefined,
      contentSource: (r.content_source as 'feed' | 'readability') ?? undefined,
      failureReason: (r.failure_reason as ArticleLogEntry['failureReason']) ?? null,
      extractMs: (r.extract_ms as number) ?? undefined,
    }));
  }

  /** Most recent runs, newest first. Used by the failure alert email. */
  recent(limit = 10): RunSummary[] {
    return this.db
      .prepare(
        `SELECT id, digest_date, folder, status, included, duration_ms, error, started_at,
                peak_rss_bytes, concurrency
         FROM run_log ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as RunSummary[];
  }
}

export interface RunSummary {
  id: number;
  digest_date: string;
  folder: string;
  status: string;
  included: number;
  duration_ms: number | null;
  error: string | null;
  started_at: number;
  /** NULL for runs recorded before build cost was measured. */
  peak_rss_bytes: number | null;
  concurrency: number | null;
}

// ─── Delivery outbox ─────────────────────────────────────────────────────────

export type DeliveryState =
  | 'pending'
  | 'building'
  | 'built'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'skipped';

export interface DeliveryRow {
  id: number;
  digest_date: string;
  folder: string;
  state: DeliveryState;
  attempts: number;
  next_attempt_at: number;
  epub_path: string | null;
  epub_bytes: number | null;
  article_count: number | null;
  message_id: string | null;
  last_error: string | null;
  claimed_at: number | null;
  alerted_at: number | null;
  created_at: number;
  updated_at: number;
}

/**
 * The durable outbox. Every state transition is a committed write, so a crash
 * or OOM at any point leaves a row that the startup sweep can recover.
 */
export class DeliveryRepo {
  constructor(private db: DB) {}

  /**
   * Queue a digest for delivery. Idempotent via UNIQUE(digest_date, folder):
   * a double-clicked "Send all", a duplicated scheduler timer and the startup
   * catch-up can all race without ever producing two emails.
   * Returns true if a new row was created.
   */
  enqueue(digestDate: string, folder: string, now: number = Date.now()): boolean {
    const info = this.db
      .prepare(
        `INSERT INTO delivery
           (digest_date, folder, state, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, 'pending', ?, ?, ?)
         ON CONFLICT (digest_date, folder) DO NOTHING`,
      )
      .run(digestDate, folder, now, now, now);
    return info.changes > 0;
  }

  get(id: number): DeliveryRow | undefined {
    return this.db.prepare('SELECT * FROM delivery WHERE id = ?').get(id) as
      | DeliveryRow
      | undefined;
  }

  find(digestDate: string, folder: string): DeliveryRow | undefined {
    return this.db
      .prepare('SELECT * FROM delivery WHERE digest_date = ? AND folder = ?')
      .get(digestDate, folder) as DeliveryRow | undefined;
  }

  /**
   * Atomically claim the next due row. `pending` moves to `building`; `built`
   * moves straight to `sending` so a send retry never rebuilds the EPUB.
   * The conditional UPDATE is the lock — if another tick already took the row,
   * `changes` is 0 and we skip it.
   */
  claimDue(now: number = Date.now()): DeliveryRow | undefined {
    for (;;) {
      const candidate = this.db
        .prepare(
          `SELECT * FROM delivery
           WHERE state IN ('pending', 'built') AND next_attempt_at <= ?
           ORDER BY next_attempt_at, id LIMIT 1`,
        )
        .get(now) as DeliveryRow | undefined;
      if (!candidate) return undefined;

      const target: DeliveryState = candidate.state === 'built' ? 'sending' : 'building';
      const info = this.db
        .prepare(
          `UPDATE delivery SET state = ?, claimed_at = ?, updated_at = ?
           WHERE id = ? AND state = ?`,
        )
        .run(target, now, now, candidate.id, candidate.state);
      if (info.changes === 1) return this.get(candidate.id);
      // Lost the race; try the next candidate.
    }
  }

  markBuilt(id: number, epubPath: string, epubBytes: number, articleCount: number): void {
    this.db
      .prepare(
        `UPDATE delivery
         SET state = 'built', epub_path = ?, epub_bytes = ?, article_count = ?,
             claimed_at = NULL, next_attempt_at = ?, updated_at = ?, last_error = NULL
         WHERE id = ?`,
      )
      .run(epubPath, epubBytes, articleCount, Date.now(), Date.now(), id);
  }

  markSent(id: number, messageId: string | null): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE delivery
         SET state = 'sent', message_id = ?, claimed_at = NULL, last_error = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(messageId, now, id);
  }

  /** Nothing to deliver (no included articles). Terminal, but not a failure. */
  markSkipped(id: number, reason: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE delivery SET state = 'skipped', last_error = ?, claimed_at = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(reason, now, id);
  }

  /**
   * Record a failed attempt. Goes back to `pending` (or `built`, preserving a
   * successful build so the retry only re-sends) until retries are exhausted
   * or the error is permanent, then `failed`.
   */
  recordFailure(
    id: number,
    error: string,
    opts: { retry: boolean; nextAttemptAt: number; hasBuild: boolean },
  ): DeliveryState {
    const now = Date.now();
    const next: DeliveryState = opts.retry ? (opts.hasBuild ? 'built' : 'pending') : 'failed';
    this.db
      .prepare(
        `UPDATE delivery
         SET state = ?, attempts = attempts + 1, last_error = ?,
             next_attempt_at = ?, claimed_at = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(next, error.slice(0, 2000), opts.nextAttemptAt, now, id);
    return next;
  }

  /**
   * Recover rows abandoned mid-flight by a crash, OOM kill or restart. Without
   * this they would sit in `building`/`sending` forever — the exact reason the
   * old `run_log` filled up with permanently-'running' rows.
   */
  requeueStale(olderThanMs: number, now: number = Date.now()): number {
    const cutoff = now - olderThanMs;
    const info = this.db
      .prepare(
        `UPDATE delivery
         SET state = CASE WHEN state = 'sending' AND epub_path IS NOT NULL THEN 'built'
                          ELSE 'pending' END,
             attempts = attempts + 1,
             last_error = 'interrupted (process restart or out-of-memory)',
             next_attempt_at = ?, claimed_at = NULL, updated_at = ?
         WHERE state IN ('building', 'sending') AND claimed_at IS NOT NULL AND claimed_at < ?`,
      )
      .run(now, now, cutoff);
    return info.changes;
  }

  /** Failed deliveries that still need their one-shot alert email. */
  dueForAlert(): DeliveryRow[] {
    return this.db
      .prepare(`SELECT * FROM delivery WHERE state = 'failed' AND alerted_at IS NULL ORDER BY id`)
      .all() as DeliveryRow[];
  }

  markAlerted(id: number): void {
    this.db
      .prepare('UPDATE delivery SET alerted_at = ?, updated_at = ? WHERE id = ?')
      .run(Date.now(), Date.now(), id);
  }

  recent(limit = 20): DeliveryRow[] {
    return this.db
      .prepare('SELECT * FROM delivery ORDER BY id DESC LIMIT ?')
      .all(limit) as DeliveryRow[];
  }

  /** EPUBs on disk that are no longer needed, for retention pruning. */
  prunableArtifacts(beforeDate: string): DeliveryRow[] {
    return this.db
      .prepare(
        `SELECT * FROM delivery
         WHERE epub_path IS NOT NULL AND digest_date < ? AND state IN ('sent', 'skipped', 'failed')`,
      )
      .all(beforeDate) as DeliveryRow[];
  }

  clearArtifact(id: number): void {
    this.db
      .prepare('UPDATE delivery SET epub_path = NULL, updated_at = ? WHERE id = ?')
      .run(Date.now(), id);
  }
}
