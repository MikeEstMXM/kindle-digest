import type { FeedRepo, ArticleRepo } from '../db/feedRepos.js';
import type { NormalizedArticle } from './types.js';

/**
 * Local reader client backed by
 * the local SQLite articles table instead of an external HTTP API.
 */
export class ReaderClient {
  constructor(
    private feeds: FeedRepo,
    private articles: ArticleRepo,
  ) {}

  async getFolders(): Promise<string[]> {
    return this.feeds.folders();
  }

  async getRecentByFolder(folder: string, sinceMs: number): Promise<NormalizedArticle[]> {
    return this.articles.recentByFolder(folder, sinceMs);
  }
}
