import { describe, it, expect } from 'vitest';
import { groupIncludedByFolder, feedCounts } from '../src/digest/grouping.js';
import type { NormalizedArticle } from '../src/reader/types.js';

function art(over: Partial<NormalizedArticle> & { folder: string }): NormalizedArticle & {
  folder: string;
} {
  return {
    itemId: over.itemId ?? 'x',
    title: over.title ?? 't',
    url: 'https://e/x',
    feedTitle: over.feedTitle ?? 'Feed',
    contentHtml: '',
    contentTextLength: 0,
    ...over,
  };
}

describe('groupIncludedByFolder', () => {
  const articles = [
    art({ itemId: 'a', folder: 'Tech' }),
    art({ itemId: 'b', folder: 'News' }),
    art({ itemId: 'c', folder: 'Tech' }),
    art({ itemId: 'd', folder: 'News' }),
  ];

  it('groups by folder and drops excluded items', () => {
    const groups = groupIncludedByFolder(articles, new Set(['c']));
    const tech = groups.find((g) => g.folder === 'Tech')!;
    const news = groups.find((g) => g.folder === 'News')!;
    expect(tech.articles.map((a) => a.itemId)).toEqual(['a']);
    expect(news.articles.map((a) => a.itemId)).toEqual(['b', 'd']);
  });

  it('omits folders with no included articles', () => {
    const groups = groupIncludedByFolder(articles, new Set(['a', 'c']));
    expect(groups.map((g) => g.folder)).toEqual(['News']);
  });

  it('returns folders sorted alphabetically', () => {
    const groups = groupIncludedByFolder(articles, new Set());
    expect(groups.map((g) => g.folder)).toEqual(['News', 'Tech']);
  });
});

describe('feedCounts', () => {
  it('counts articles per feed, sorted by count desc', () => {
    const counts = feedCounts([
      art({ folder: 'T', feedTitle: 'Verge' }),
      art({ folder: 'T', feedTitle: 'Ars' }),
      art({ folder: 'T', feedTitle: 'Verge' }),
    ]);
    expect(counts).toEqual([
      { name: 'Verge', count: 2 },
      { name: 'Ars', count: 1 },
    ]);
  });
});
