import { OWNER_USER_ID, type DB } from './schema.js';
import { textLength } from '../util/html.js';
import type { NormalizedArticle } from '../reader/types.js';
import type { TemplateId } from '../cover/hash.js';

// ─── Folder settings repo ─────────────────────────────────────────────────────

export interface FolderSettings {
  folder: string;
  cadence: 'daily' | 'weekly';
  deliveryDay: number; // 0=Sun, 1=Mon, …, 6=Sat (only used when cadence='weekly')
  coverTemplate: TemplateId | null; // null = auto-assign from folder name hash
  coverTheme: 'light' | 'dark';
}

function rowToFolderSettings(row: Record<string, unknown>): FolderSettings {
  return {
    folder: row.folder as string,
    cadence: row.cadence as 'daily' | 'weekly',
    deliveryDay: row.delivery_day as number,
    coverTemplate: (row.cover_template as TemplateId | null) ?? null,
    coverTheme: ((row.cover_theme as string) === 'light' ? 'light' : 'dark'),
  };
}

export class FolderSettingsRepo {
  constructor(
    private db: DB,
    private userId: number = OWNER_USER_ID,
  ) {}

  get(folder: string): FolderSettings {
    const row = this.db
      .prepare('SELECT * FROM folder_settings WHERE user_id = ? AND folder = ?')
      .get(this.userId, folder) as Record<string, unknown> | undefined;
    if (!row) return { folder, cadence: 'daily', deliveryDay: 0, coverTemplate: null, coverTheme: 'dark' };
    return rowToFolderSettings(row);
  }

  set(folder: string, cadence: 'daily' | 'weekly', deliveryDay: number): void {
    this.db
      .prepare(
        `INSERT INTO folder_settings (user_id, folder, cadence, delivery_day) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, folder) DO UPDATE SET
           cadence = excluded.cadence,
           delivery_day = excluded.delivery_day`,
      )
      .run(this.userId, folder, cadence, deliveryDay);
  }

  setCover(folder: string, coverTemplate: TemplateId | null, coverTheme: 'light' | 'dark'): void {
    this.db
      .prepare(
        `INSERT INTO folder_settings (user_id, folder, cadence, delivery_day, cover_template, cover_theme)
         VALUES (?, ?, 'daily', 0, ?, ?)
         ON CONFLICT(user_id, folder) DO UPDATE SET
           cover_template = excluded.cover_template,
           cover_theme = excluded.cover_theme`,
      )
      .run(this.userId, folder, coverTemplate, coverTheme);
  }

  allAsMap(): Map<string, FolderSettings> {
    const rows = this.db
      .prepare('SELECT * FROM folder_settings WHERE user_id = ?')
      .all(this.userId) as Record<string, unknown>[];
    const map = new Map<string, FolderSettings>();
    for (const r of rows) {
      map.set(r.folder as string, rowToFolderSettings(r));
    }
    return map;
  }

  renameFolder(oldName: string, newName: string): void {
    this.db
      .prepare('UPDATE folder_settings SET folder = ? WHERE user_id = ? AND folder = ?')
      .run(newName, this.userId, oldName);
  }
}

// ─── Feed repo ────────────────────────────────────────────────────────────────

export interface Feed {
  id: number;
  url: string;
  title: string;
  folder: string;
  lastFetchedAt?: number;
  lastError?: string;
  createdAt: number;
}

function mapFeed(row: Record<string, unknown>): Feed {
  return {
    id: row.id as number,
    url: row.url as string,
    title: row.title as string,
    folder: row.folder as string,
    lastFetchedAt: (row.last_fetched_at as number | null) ?? undefined,
    lastError: (row.last_error as string | null) ?? undefined,
    createdAt: row.created_at as number,
  };
}

export class FeedRepo {
  constructor(
    private db: DB,
    readonly userId: number = OWNER_USER_ID,
  ) {}

  add(url: string, title: string, folder: string): Feed {
    const now = Date.now();
    const info = this.db
      .prepare('INSERT INTO feeds (user_id, url, title, folder, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(this.userId, url, title, folder, now);
    return { id: Number(info.lastInsertRowid), url, title, folder, createdAt: now };
  }

  all(): Feed[] {
    return (
      this.db
        .prepare('SELECT * FROM feeds WHERE user_id = ? ORDER BY folder, title')
        .all(this.userId) as Record<string, unknown>[]
    ).map(mapFeed);
  }

  get(id: number): Feed | undefined {
    const row = this.db
      .prepare('SELECT * FROM feeds WHERE id = ? AND user_id = ?')
      .get(id, this.userId) as
      | Record<string, unknown>
      | undefined;
    return row ? mapFeed(row) : undefined;
  }

  folders(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT folder FROM feeds WHERE user_id = ? ORDER BY folder')
      .all(this.userId) as { folder: string }[];
    return rows.map((r) => r.folder);
  }

  setTitle(id: number, title: string): void {
    this.db
      .prepare('UPDATE feeds SET title = ? WHERE id = ? AND user_id = ?')
      .run(title, id, this.userId);
  }

  setFetched(id: number, error?: string): void {
    this.db
      .prepare('UPDATE feeds SET last_fetched_at = ?, last_error = ? WHERE id = ? AND user_id = ?')
      .run(Date.now(), error ?? null, id, this.userId);
  }

  renameFolder(oldName: string, newName: string): void {
    this.db
      .prepare('UPDATE feeds SET folder = ? WHERE user_id = ? AND folder = ?')
      .run(newName, this.userId, oldName);
  }

  moveToFolder(id: number, folder: string): void {
    this.db
      .prepare('UPDATE feeds SET folder = ? WHERE id = ? AND user_id = ?')
      .run(folder, id, this.userId);
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM feeds WHERE id = ? AND user_id = ?').run(id, this.userId);
  }
}

// ─── Article repo ─────────────────────────────────────────────────────────────

export interface ArticleInput {
  guid: string;
  title: string;
  url: string;
  author?: string;
  contentHtml: string;
  publishedAt?: number;
}

export class ArticleRepo {
  constructor(
    private db: DB,
    private userId: number = OWNER_USER_ID,
  ) {}

  upsert(feedId: number, items: ArticleInput[]): void {
    if (items.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT INTO articles
        (feed_id, guid, title, url, author, content_html, published_at, fetched_at, status)
      VALUES
        (@feedId, @guid, @title, @url, @author, @contentHtml, @publishedAt, @fetchedAt, 'unread')
      ON CONFLICT(feed_id, guid) DO UPDATE SET
        title        = excluded.title,
        url          = excluded.url,
        author       = excluded.author,
        content_html = excluded.content_html,
        published_at = COALESCE(excluded.published_at, articles.published_at)
    `);
    const now = Date.now();
    const tx = this.db.transaction(() => {
      for (const item of items) {
        stmt.run({ feedId, fetchedAt: now, author: null, publishedAt: null, ...item });
      }
    });
    tx();
  }

  recentByFolder(folder: string, sinceMs: number): NormalizedArticle[] {
    const rows = this.db
      .prepare(`
        SELECT a.id, a.title, a.url, a.author, a.content_html, a.published_at,
               f.title AS feed_title, f.url AS feed_url
        FROM articles a
        JOIN feeds f ON f.id = a.feed_id
        WHERE f.user_id = ? AND f.folder = ? AND COALESCE(a.published_at, a.fetched_at) >= ?
        ORDER BY COALESCE(a.published_at, a.fetched_at) DESC
      `)
      .all(this.userId, folder, sinceMs) as Record<string, unknown>[];
    return rows.map((r) => {
      const html = (r.content_html as string) ?? '';
      return {
        itemId: String(r.id),
        title: (r.title as string) || '(untitled)',
        url: (r.url as string) ?? '',
        author: (r.author as string | null) ?? undefined,
        publishedMs: (r.published_at as number | null) ?? undefined,
        feedTitle: (r.feed_title as string) ?? 'Unknown feed',
        feedUrl: (r.feed_url as string) ?? undefined,
        contentHtml: html,
        contentTextLength: textLength(html),
      };
    });
  }

  /** Delete articles older than the given cutoff (epoch ms). */
  pruneOld(cutoffMs: number): void {
    this.db
      .prepare(
        'DELETE FROM articles WHERE fetched_at < ? AND feed_id IN (SELECT id FROM feeds WHERE user_id = ?)',
      )
      .run(cutoffMs, this.userId);
  }
}
