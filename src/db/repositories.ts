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

  finish(runId: number, status: 'sent' | 'error', durationMs: number, error?: string): void {
    this.db
      .prepare(
        `UPDATE run_log SET finished_at = ?, duration_ms = ?, status = ?, error = ? WHERE id = ?`,
      )
      .run(Date.now(), durationMs, status, error ?? null, runId);
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
}
