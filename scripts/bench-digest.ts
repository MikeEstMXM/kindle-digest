/**
 * Benchmark a large digest build: peak RSS, wall-clock, EPUB size.
 *
 * Sized against the real case that motivated the delivery rework — the weekly
 * news digest of 2026-08-23, 157 articles.
 *
 * Synthetic (no network, no DB):
 *   npx tsx scripts/bench-digest.ts --articles 157
 *
 * The stub fetchers return instantly by default, which measures CPU cost only
 * and hides the fact that a real build is dominated by serial network waits.
 * --latency makes each stubbed fetch sleep, so wall-clock reflects a realistic
 * I/O profile and concurrency changes are actually visible:
 *   npx tsx scripts/bench-digest.ts --articles 157 --latency 300
 *
 * Against the real database (run on the Fly machine):
 *   fly ssh console --app kindle-digest
 *   cd /app && npx tsx scripts/bench-digest.ts \
 *     --db /data/kindle-digest.sqlite --folder News --date 2026-08-23
 *
 * --db alone still stubs the network, so every article gets the *same* image.
 * Real feeds serve a distinct image per article, which is the case libvips'
 * cache can never help with — add --real-fetch to measure that. This is the
 * only mode whose memory figures reflect real image churn:
 *   cd /app && npx tsx scripts/bench-digest.ts --db /data/kindle-digest.sqlite \
 *     --folder News --date 2026-08-23 --real-fetch --concurrency 1
 *
 * On a 512 MB VM, step --concurrency up from 1 rather than starting at the
 * default: a build peak on top of the running app can OOM the machine.
 *
 * To emulate the 512 MB VM ceiling locally:
 *   node --max-old-space-size=450 --import tsx scripts/bench-digest.ts --articles 157
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { configureSharp } from '../src/content/sharpConfig.js';
import { DEFAULT_BUILD_CONCURRENCY } from '../src/util/concurrency.js';
// Shared with the production build so both measure identically.
import { PeakMemory } from '../src/util/peakMemory.js';
import { buildFolderDigest } from '../src/digest/orchestrator.js';
import { loadFontBuffers } from '../src/cover/fontLoader.js';
import { openDb } from '../src/db/schema.js';
import { FeedRepo, ArticleRepo } from '../src/db/feedRepos.js';
import { ReaderClient } from '../src/reader/client.js';
import type { NormalizedArticle } from '../src/reader/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FONTS = join(__dirname, '..', 'assets', 'fonts');

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/** Articles shaped like a real news digest: mixed full-text and short entries. */
function syntheticArticles(count: number): NormalizedArticle[] {
  const feeds = ['The Guardian', 'Reuters', 'AP News', 'BBC', 'Ars Technica', 'The Verge'];
  return Array.from({ length: count }, (_, i) => {
    // Every 4th article is short, forcing the Readability fallback path.
    const short = i % 4 === 3;
    const paragraphs = short ? 1 : 25 + (i % 20);
    const body =
      `<p><img src="https://img.example.com/hero-${i}.jpg" alt="hero"/></p>` +
      `<p>Lead paragraph for article ${i}. </p>` +
      '<p>A representative paragraph of news copy with enough words to look like real body text on the page. </p>'.repeat(
        paragraphs,
      );
    return {
      itemId: `bench-${i}`,
      title: `Benchmark article ${i}: a reasonably long headline of the sort news feeds emit`,
      url: `https://example.com/article/${i}`,
      feedTitle: feeds[i % feeds.length],
      author: 'Staff Reporter',
      publishedMs: Date.parse('2026-08-23T08:00:00Z') + i * 60_000,
      contentHtml: body,
      contentTextLength: short ? 40 : paragraphs * 100,
    };
  });
}

async function loadFromDb(
  dbPath: string,
  folder: string,
  isoDate: string,
): Promise<NormalizedArticle[]> {
  const db = openDb(dbPath);
  const client = new ReaderClient(new FeedRepo(db), new ArticleRepo(db));
  // Weekly window anchored to the end of the target date, matching service.ts.
  const anchor = Date.parse(`${isoDate}T00:00:00Z`) + 24 * 60 * 60 * 1000;
  return client.getRecentByFolder(folder, anchor - 7 * 24 * 60 * 60 * 1000);
}

async function main(): Promise<void> {
  configureSharp();
  const dbPath = arg('db');
  const folder = arg('folder', 'News')!;
  const isoDate = arg('date', '2026-08-23')!;
  const count = Number(arg('articles', '157'));
  // Per-fetch delay for the stubs. Real page/image fetches cost 100s of ms each
  // and the build issues one per article plus up to 5 images, so this is the
  // term that dominates a production build.
  const latency = Number(arg('latency', '0'));
  const concurrency = Number(arg('concurrency', String(DEFAULT_BUILD_CONCURRENCY)));
  // Hit the real network instead of the stubs. This is the only mode that
  // exercises real per-article images: the stub serves one identical JPEG for
  // every article, so libvips' cache hits in a way it never can on real feeds.
  const realFetch = process.argv.includes('--real-fetch');

  if (realFetch && latency > 0) {
    console.error('--latency and --real-fetch are mutually exclusive: the real network supplies');
    console.error('its own latency. Drop --latency for a real-fetch run.');
    process.exit(1);
  }

  const articles = dbPath ? await loadFromDb(dbPath, folder, isoDate) : syntheticArticles(count);

  if (articles.length === 0) {
    console.error(`No articles found for ${folder} on ${isoDate}.`);
    process.exit(1);
  }

  // Offline stand-ins so the benchmark measures build cost, not the network.
  // Skipped entirely under --real-fetch, where the orchestrator falls back to
  // defaultPageFetcher and the global fetch.
  const stubPage = async (url: string) => {
    await sleep(latency);
    return {
      status: 200,
      body:
        `<html><head><title>Recovered</title></head><body><article><h1>Recovered</h1>` +
        `<p>Full text recovered from ${url} by the Readability fallback. </p>`.repeat(30) +
        `</article></body></html>`,
    };
  };
  const sampleImage = await sharp({
    create: { width: 1600, height: 1200, channels: 3, background: { r: 110, g: 110, b: 110 } },
  })
    .jpeg()
    .toBuffer();
  const stubImage = (async () => {
    await sleep(latency);
    return new Response(new Uint8Array(sampleImage), { status: 200 });
  }) as unknown as typeof fetch;

  // undefined makes buildFolderDigest use its real fetchers.
  const fetchPage = realFetch ? undefined : stubPage;
  const fetchImage = realFetch ? undefined : stubImage;

  const outDir = mkdtempSync(join(tmpdir(), 'bench-digest-'));
  const meter = new PeakMemory();

  console.log(
    `Building "${folder}" for ${isoDate} — ${articles.length} articles ` +
      `(${dbPath ? 'real DB' : 'synthetic articles'}, ` +
      `${realFetch ? 'REAL network' : `stubbed network @ ${latency} ms/fetch`}, ` +
      `concurrency ${concurrency})\n`,
  );

  meter.start();
  const started = Date.now();
  let built;
  try {
    built = await buildFolderDigest(folder, articles, articles.length, {
      isoDate,
      timezone: 'America/New_York',
      author: 'Benchmark',
      minChars: 1800,
      fonts: loadFontBuffers(FONTS),
      outDir,
      concurrency,
      fetchPage,
      fetchImage,
    });
  } finally {
    const peak = meter.stop();
    const elapsed = Date.now() - started;
    console.log(`  wall clock : ${(elapsed / 1000).toFixed(1)}s`);
    const pctOfVm = Math.round((peak / (512 * 1024 * 1024)) * 100);
    console.log(`  peak RSS   : ${mb(peak)}  (${pctOfVm}% of the 512 MB Fly VM)`);
    const snap = meter.peakSnapshot;
    console.log(
      `  at peak    : heapUsed ${mb(snap.heapUsed)} | heapTotal ${mb(snap.heapTotal)} | ` +
        `external ${mb(snap.external)} | arrayBuffers ${mb(snap.arrayBuffers)}`,
    );
    console.log(`  unaccounted: ${mb(snap.rss - snap.heapTotal - snap.external)} (native/malloc)`);
    if (built) {
      console.log(`  epub size  : ${(built.epubBytes / 1024 / 1024).toFixed(1)} MB`);
      console.log(`  per article: ${(elapsed / articles.length).toFixed(0)} ms`);
    }
    rmSync(outDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
