import type { DB } from './schema.js';
import { textLength } from '../util/html.js';
import type { NormalizedArticle } from '../reader/types.js';

// ─── Folder settings repo ─────────────────────────────────────────────────────

export interface FolderSettings {
  folder: string;
  cadence: 'daily' | 'weekly';
  deliveryDay: number; // 0=Sun, 1=Mon, …, 6=Sat (only used when cadence='weekly')
  maxArticles: number; // cap on articles included per digest (default 20)
}

export class FolderSettingsRepo {
  constructor(private db: DB) {}

  get(folder: string): FolderSettings {
    const row = this.db
      .prepare('SELECT * FROM folder_settings WHERE folder = ?')
      .get(folder) as Record<string, unknown> | undefined;
    if (!row) return { folder, cadence: 'daily', deliveryDay: 0, maxArticles: 20 };
    return {
      folder: row.folder as string,
      cadence: row.cadence as 'daily' | 'weekly',
      deliveryDay: row.delivery_day as number,
      maxArticles: (row.max_articles as number | null) ?? 20,
    };
  }

  set(folder: string, cadence: 'daily' | 'weekly', deliveryDay: number, maxArticles: number): void {
    this.db
      .prepare(
        `INSERT INTO folder_settings (folder, cadence, delivery_day, max_articles) VALUES (?, ?, ?, ?)
         ON CONFLICT(folder) DO UPDATE SET
           cadence = excluded.cadence,
           delivery_day = excluded.delivery_day,
           max_articles = excluded.max_articles`,
      )
      .run(folder, cadence, deliveryDay, maxArticles);
  }

  allAsMap(): Map<string, FolderSettings> {
    const rows = this.db
      .prepare('SELECT * FROM folder_settings')
      .all() as Record<string, unknown>[];
    const map = new Map<string, FolderSettings>();
    for (const r of rows) {
      const folder = r.folder as string;
      map.set(folder, {
        folder,
        cadence: r.cadence as 'daily' | 'weekly',
        deliveryDay: r.delivery_day as number,
        maxArticles: (r.max_articles as number | null) ?? 20,
      });
    }
    return map;
  }

  renameFolder(oldName: string, newName: string): void {
    this.db
      .prepare('UPDATE folder_settings SET folder = ? WHERE folder = ?')
      .run(newName, oldName);
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
  constructor(private db: DB) {}

  add(url: string, title: string, folder: string): Feed {
    const now = Date.now();
    const info = this.db
      .prepare('INSERT INTO feeds (url, title, folder, created_at) VALUES (?, ?, ?, ?)')
      .run(url, title, folder, now);
    return { id: Number(info.lastInsertRowid), url, title, folder, createdAt: now };
  }

  all(): Feed[] {
    return (
      this.db.prepare('SELECT * FROM feeds ORDER BY folder, title').all() as Record<string, unknown>[]
    ).map(mapFeed);
  }

  get(id: number): Feed | undefined {
    const row = this.db.prepare('SELECT * FROM feeds WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapFeed(row) : undefined;
  }

  folders(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT folder FROM feeds ORDER BY folder')
      .all() as { folder: string }[];
    return rows.map((r) => r.folder);
  }

  setTitle(id: number, title: string): void {
    this.db.prepare('UPDATE feeds SET title = ? WHERE id = ?').run(title, id);
  }

  setFetched(id: number, error?: string): void {
    this.db
      .prepare('UPDATE feeds SET last_fetched_at = ?, last_error = ? WHERE id = ?')
      .run(Date.now(), error ?? null, id);
  }

  renameFolder(oldName: string, newName: string): void {
    this.db.prepare('UPDATE feeds SET folder = ? WHERE folder = ?').run(newName, oldName);
  }

  moveToFolder(id: number, folder: string): void {
    this.db.prepare('UPDATE feeds SET folder = ? WHERE id = ?').run(folder, id);
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM feeds WHERE id = ?').run(id);
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
  constructor(private db: DB) {}

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
        published_at = excluded.published_at
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
        WHERE f.folder = ? AND a.fetched_at >= ?
        ORDER BY a.published_at DESC
      `)
      .all(folder, sinceMs) as Record<string, unknown>[];
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
    this.db.prepare('DELETE FROM articles WHERE fetched_at < ?').run(cutoffMs);
  }
}
