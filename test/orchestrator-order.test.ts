import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { buildFolderDigest } from '../src/digest/orchestrator.js';
import type { NormalizedArticle } from '../src/reader/types.js';

/**
 * Articles are extracted and rendered concurrently, so completion order no
 * longer matches input order. Everything a reader sees — spine order, article
 * filenames, feed sectioning, prev/next links — must still be derived from
 * input position alone. This is the regression that concurrency would cause.
 */
function articles(n: number): NormalizedArticle[] {
  const feeds = ['Guardian', 'Reuters', 'AP'];
  return Array.from({ length: n }, (_, i) => ({
    itemId: `a-${i}`,
    title: `Article ${i}`,
    url: `https://example.com/${i}`,
    feedTitle: feeds[i % feeds.length],
    publishedMs: 1_756_000_000_000 + i * 60_000,
    contentHtml: '<p>Body copy long enough to count as full text. </p>'.repeat(60),
    contentTextLength: 3000,
  }));
}

/** Staggered so later articles finish before earlier ones at high concurrency. */
const fetchPage = async (url: string) => {
  const n = Number(url.split('/').pop());
  await new Promise((r) => setTimeout(r, (20 - (n % 20)) * 2));
  return { status: 200, body: '<html><body><article><p>x</p></article></body></html>' };
};

async function structure(concurrency: number): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), 'order-'));
  try {
    const built = await buildFolderDigest('News', articles(24), 24, {
      isoDate: '2026-08-23',
      timezone: 'America/New_York',
      minChars: 1800,
      fonts: [],
      outDir,
      concurrency,
      fetchPage,
      // No image fetcher: images are dropped, keeping the test fast and
      // focused on ordering rather than on sharp.
      fetchImage: (async () => {
        throw new Error('no images');
      }) as unknown as typeof fetch,
    });
    const zip = await JSZip.loadAsync(readFileSync(built.epubPath));
    const opf = await zip.file('OEBPS/content.opf')!.async('string');
    const spine = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map((m) => m[1]);
    const toc = await zip.file('OEBPS/toc.xhtml')!.async('string');
    const order = [...toc.matchAll(/href="(art-\d+\.xhtml)"/g)].map((m) => m[1]);
    const first = await zip.file('OEBPS/art-1.xhtml')!.async('string');
    return JSON.stringify({ spine, order, firstTitle: /Article \d+/.exec(first)?.[0] });
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

describe('digest build ordering under concurrency', () => {
  it('produces identical book structure at concurrency 1 and 8', async () => {
    const serial = await structure(1);
    const parallel = await structure(8);
    expect(parallel).toEqual(serial);
  }, 60_000);

  it('groups by feed in input order, not completion order', async () => {
    const parsed = JSON.parse(await structure(8)) as { order: string[]; firstTitle: string };
    // Articles round-robin across 3 feeds, and the ToC is grouped by feed, so
    // the expected order is every 3rd article: feed 0 first, then 1, then 2.
    // Within each feed, input order must be preserved exactly.
    const expected = [0, 1, 2].flatMap((feed) =>
      Array.from({ length: 8 }, (_, k) => `art-${feed + k * 3 + 1}.xhtml`),
    );
    expect(parsed.order).toEqual(expected);
    // Filenames are assigned by input index, so art-1 is always the first input.
    expect(parsed.firstTitle).toBe('Article 0');
  }, 60_000);
});
