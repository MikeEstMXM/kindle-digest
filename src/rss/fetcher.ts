import RSSParser from 'rss-parser';
import type { FeedRepo, ArticleRepo, ArticleInput } from '../db/feedRepos.js';

type ParsedItem = {
  title?: string;
  link?: string;
  guid?: string;
  isoDate?: string;
  author?: string;
  content?: string;
  contentEncoded?: string;
};

const parser = new RSSParser<Record<string, unknown>, ParsedItem>({
  customFields: {
    item: [['content:encoded', 'contentEncoded']],
  },
  timeout: 15_000,
});

/** Fetch a single RSS/Atom feed URL, parse it, and upsert articles into the DB. */
export async function fetchFeed(
  feedId: number,
  url: string,
  articles: ArticleRepo,
  feeds: FeedRepo,
): Promise<{ title: string; itemCount: number }> {
  const parsed = await parser.parseURL(url);
  const feedTitle = parsed.title ?? '';
  if (feedTitle) feeds.setTitle(feedId, feedTitle);

  const items: ArticleInput[] = [];
  for (const item of parsed.items ?? []) {
    const guid = item.guid ?? item.link ?? '';
    if (!guid) continue;
    const contentHtml = item.contentEncoded ?? item.content ?? '';
    const publishedAt = item.isoDate ? new Date(item.isoDate).getTime() : undefined;
    items.push({
      guid,
      title: item.title ?? '(untitled)',
      url: item.link ?? '',
      author: item.author || undefined,
      contentHtml,
      publishedAt,
    });
  }

  articles.upsert(feedId, items);
  return { title: feedTitle, itemCount: items.length };
}

/** Fetch all feeds in sequence, recording errors per-feed. */
export async function fetchAllFeeds(feeds: FeedRepo, articles: ArticleRepo): Promise<void> {
  const allFeeds = feeds.all();
  for (const feed of allFeeds) {
    try {
      await fetchFeed(feed.id, feed.url, articles, feeds);
      feeds.setFetched(feed.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      feeds.setFetched(feed.id, msg);
      console.error(`[rss] Failed to fetch ${feed.url}: ${msg}`);
    }
  }
  // Prune articles older than 30 days.
  articles.pruneOld(Date.now() - 30 * 24 * 60 * 60 * 1000);
}
