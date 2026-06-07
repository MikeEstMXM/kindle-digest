/** Raw Inoreader (Google-Reader-compatible) API shapes we consume. */

export interface InoreaderItemContent {
  content?: string;
  direction?: string;
}

export interface InoreaderItemOrigin {
  streamId?: string;
  title?: string; // feed title
  htmlUrl?: string;
}

export interface InoreaderItem {
  id: string; // e.g. "tag:google.com,2005:reader/item/00000000abcdef01"
  title?: string;
  published?: number; // epoch seconds
  canonical?: { href: string }[];
  alternate?: { href: string; type?: string }[];
  summary?: InoreaderItemContent;
  content?: InoreaderItemContent;
  origin?: InoreaderItemOrigin;
  categories?: string[];
  author?: string;
}

export interface StreamContentsResponse {
  id: string;
  title?: string;
  continuation?: string;
  items: InoreaderItem[];
}

export interface SubscriptionCategory {
  id: string; // "user/<id>/label/<FolderName>"
  label: string; // "FolderName"
}

export interface Subscription {
  id: string; // "feed/https://..."
  title: string;
  categories: SubscriptionCategory[];
  htmlUrl?: string;
}

export interface SubscriptionListResponse {
  subscriptions: Subscription[];
}

export interface TagListResponse {
  tags: { id: string; type?: string; unread_count?: number }[];
}

// ─── Normalised app-facing shapes ────────────────────────────────────────────

export interface NormalizedArticle {
  itemId: string;
  title: string;
  url: string;
  author?: string;
  publishedMs?: number;
  feedTitle: string;
  feedUrl?: string;
  /** Inoreader-provided HTML content (may be summary or full). */
  inoreaderHtml: string;
  /** Length in characters of the extracted text from inoreaderHtml. */
  inoreaderTextLength: number;
}

export interface FolderArticles {
  folder: string;
  articles: NormalizedArticle[];
}
