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

  it('getUnreadByFolder returns articles for the matching folder only', async () => {
    const techFeed = feedRepo.add('https://tech.example.com/feed', 'Ars Technica', 'Tech');
    const newsFeed = feedRepo.add('https://news.example.com/feed', 'NY Times', 'News');
    articleRepo.upsert(techFeed.id, [
      { guid: 'g1', title: 'Tech Article', url: 'https://tech.example.com/1', contentHtml: '<p>tech</p>' },
    ]);
    articleRepo.upsert(newsFeed.id, [
      { guid: 'g2', title: 'News Article', url: 'https://news.example.com/1', contentHtml: '<p>news</p>' },
    ]);

    const techArticles = await client.getUnreadByFolder('Tech');
    expect(techArticles).toHaveLength(1);
    expect(techArticles[0].title).toBe('Tech Article');
    expect(techArticles[0].feedTitle).toBe('Ars Technica');

    const newsArticles = await client.getUnreadByFolder('News');
    expect(newsArticles).toHaveLength(1);
    expect(newsArticles[0].title).toBe('News Article');
  });

  it('markRead removes articles from unread results', async () => {
    const feed = feedRepo.add('https://example.com/feed', 'Feed', 'Tech');
    articleRepo.upsert(feed.id, [
      { guid: 'g1', title: 'A', url: 'https://example.com/1', contentHtml: '<p>a</p>' },
      { guid: 'g2', title: 'B', url: 'https://example.com/2', contentHtml: '<p>b</p>' },
    ]);

    const before = await client.getUnreadByFolder('Tech');
    expect(before).toHaveLength(2);

    await client.markRead([before[0].itemId]);

    const after = await client.getUnreadByFolder('Tech');
    expect(after).toHaveLength(1);
    expect(after[0].title).toBe(before[1].title);
  });

  it('contentTextLength enables full-text detection', async () => {
    const feed = feedRepo.add('https://example.com/feed', 'Feed', 'Tech');
    const longHtml = `<p>${'word '.repeat(500)}</p>`;
    articleRepo.upsert(feed.id, [
      { guid: 'long', title: 'Long', url: 'https://example.com/long', contentHtml: longHtml },
      { guid: 'short', title: 'Short', url: 'https://example.com/short', contentHtml: '<p>hi</p>' },
    ]);

    const articles = await client.getUnreadByFolder('Tech');
    const long = articles.find((a) => a.title === 'Long')!;
    const short = articles.find((a) => a.title === 'Short')!;
    expect(contentIsFull(long, 1800)).toBe(true);
    expect(contentIsFull(short, 1800)).toBe(false);
  });
});
