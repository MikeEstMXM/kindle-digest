// ─── Normalised app-facing shapes ────────────────────────────────────────────

export interface NormalizedArticle {
  itemId: string;
  title: string;
  url: string;
  author?: string;
  publishedMs?: number;
  feedTitle: string;
  feedUrl?: string;
  /** HTML content fetched from the feed (full article body or summary). */
  contentHtml: string;
  /** Length in characters of the extracted text from contentHtml. */
  contentTextLength: number;
}

export interface FolderArticles {
  folder: string;
  articles: NormalizedArticle[];
}
