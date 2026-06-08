import { describe, it, expect } from 'vitest';
import { parseOpml } from '../src/rss/opml.js';

const OPML_WITH_FOLDERS = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="1.0">
  <head><title>My Feeds</title></head>
  <body>
    <outline text="Tech" title="Tech">
      <outline type="rss" text="Ars Technica" title="Ars Technica"
        xmlUrl="https://feeds.arstechnica.com/arstechnica/index"
        htmlUrl="https://arstechnica.com"/>
      <outline type="rss" text="The Verge" title="The Verge"
        xmlUrl="https://www.theverge.com/rss/index.xml"/>
    </outline>
    <outline text="News" title="News">
      <outline type="rss" text="BBC News"
        xmlUrl="https://feeds.bbci.co.uk/news/rss.xml"/>
    </outline>
    <outline type="rss" text="Root Feed"
      xmlUrl="https://example.com/feed.xml"/>
  </body>
</opml>`;

const OPML_LOWERCASE_ATTR = `<?xml version="1.0"?>
<opml version="1.0">
  <body>
    <outline text="Misc">
      <outline text="Feed A" xmlurl="https://a.example.com/feed"/>
    </outline>
  </body>
</opml>`;

describe('parseOpml', () => {
  it('maps folder outlines to folder names', () => {
    const feeds = parseOpml(OPML_WITH_FOLDERS);
    const tech = feeds.filter((f) => f.folder === 'Tech');
    expect(tech).toHaveLength(2);
    expect(tech.map((f) => f.title)).toEqual(['Ars Technica', 'The Verge']);
  });

  it('assigns root-level feeds to Uncategorized', () => {
    const feeds = parseOpml(OPML_WITH_FOLDERS);
    const uncategorized = feeds.filter((f) => f.folder === 'Uncategorized');
    expect(uncategorized).toHaveLength(1);
    expect(uncategorized[0].url).toBe('https://example.com/feed.xml');
  });

  it('parses feeds from all folders', () => {
    const feeds = parseOpml(OPML_WITH_FOLDERS);
    expect(feeds).toHaveLength(4);
    expect(feeds.map((f) => f.folder)).toEqual(['Tech', 'Tech', 'News', 'Uncategorized']);
  });

  it('handles lowercase xmlurl attribute', () => {
    const feeds = parseOpml(OPML_LOWERCASE_ATTR);
    expect(feeds).toHaveLength(1);
    expect(feeds[0].url).toBe('https://a.example.com/feed');
    expect(feeds[0].folder).toBe('Misc');
  });

  it('returns empty array for missing body', () => {
    expect(parseOpml('<opml version="1.0"></opml>')).toEqual([]);
  });
});
