import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/schema.js';
import { FeedRepo, ArticleRepo } from '../src/db/feedRepos.js';
import { ReaderClient } from '../src/reader/client.js';
import { contentIsFull } from '../src/content/fulltext.js';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

describe('ReaderClient', () => {
  let feedRepo: FeedRepo;
  let articleRepo: ArticleRepo;
  let client: ReaderClient;

  beforeEach(() => {
    const db = makeDb();
    feedRepo = new FeedRepo(db);
    articleRepo = new ArticleRepo(db);
    client = new ReaderClient(feedRepo, articleRepo);
  });

  it('getFolders returns distinct folders sorted alphabetically', async () => {
    feedRepo.add('https://tech.example.com/feed', 'Tech Feed', 'Tech');
    feedRepo.add('https://news.example.com/feed', 'News Feed', 'News');
    feedRepo.add('https://tech2.example.com/feed', 'Tech Feed 2', 'Tech');
    expect(await client.getFolders()).toEqual(['News', 'Tech']);
  });

  it('getRecentByFolder returns articles for the matching folder only', async () => {
    const techFeed = feedRepo.add('https://tech.example.com/feed', 'Ars Technica', 'Tech');
    const newsFeed = feedRepo.add('https://news.example.com/feed', 'NY Times', 'News');
    articleRepo.upsert(techFeed.id, [
      { guid: 'g1', title: 'Tech Article', url: 'https://tech.example.com/1', contentHtml: '<p>tech</p>' },
    ]);
    articleRepo.upsert(newsFeed.id, [
      { guid: 'g2', title: 'News Article', url: 'https://news.example.com/1', contentHtml: '<p>news</p>' },
    ]);

    const techArticles = await client.getRecentByFolder('Tech', 0);
    expect(techArticles).toHaveLength(1);
    expect(techArticles[0].title).toBe('Tech Article');
    expect(techArticles[0].feedTitle).toBe('Ars Technica');

    const newsArticles = await client.getRecentByFolder('News', 0);
    expect(newsArticles).toHaveLength(1);
    expect(newsArticles[0].title).toBe('News Article');
  });

  it('getRecentByFolder excludes articles older than sinceMs', async () => {
    const feed = feedRepo.add('https://example.com/feed', 'Feed', 'Tech');
    articleRepo.upsert(feed.id, [
      { guid: 'g1', title: 'Article', url: 'https://example.com/1', contentHtml: '<p>a</p>' },
    ]);
    // sinceMs in the future → nothing qualifies
    const articles = await client.getRecentByFolder('Tech', Date.now() + 60_000);
    expect(articles).toHaveLength(0);
  });

  it('contentTextLength enables full-text detection', async () => {
    const feed = feedRepo.add('https://example.com/feed', 'Feed', 'Tech');
    const longHtml = `<p>${'word '.repeat(500)}</p>`;
    articleRepo.upsert(feed.id, [
      { guid: 'long', title: 'Long', url: 'https://example.com/long', contentHtml: longHtml },
      { guid: 'short', title: 'Short', url: 'https://example.com/short', contentHtml: '<p>hi</p>' },
    ]);

    const articles = await client.getRecentByFolder('Tech', 0);
    const long = articles.find((a) => a.title === 'Long')!;
    const short = articles.find((a) => a.title === 'Short')!;
    expect(contentIsFull(long, 1800)).toBe(true);
    expect(contentIsFull(short, 1800)).toBe(false);
  });
});
