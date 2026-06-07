import { DateTime } from 'luxon';
import type { NormalizedArticle } from '../inoreader/types.js';
import type { RunLogRepo } from '../db/repositories.js';
import { inoreaderContentIsFull, type ContentSource, type FailureReason } from '../content/fulltext.js';
import { extractFullText, type PageFetcher } from '../content/extract.js';
import { sanitizeArticleHtml } from '../content/sanitize.js';
import { generateQrPng } from '../content/qr.js';
import {
  downloadImage,
  findCoverImageUrl,
  processCoverImage,
} from '../content/images.js';
import { renderCover, IMAGE_ADJUST } from '../cover/render.js';
import { templateFor } from '../cover/hash.js';
import { buildArticlePage } from '../epub/article.js';
import { buildEpub, type EpubArticle, type EpubBinary } from '../epub/writer.js';
import { buildDiagnosticsPage } from '../diagnostics/build.js';
import { feedCounts } from './grouping.js';
import type { LoadedFont } from '../cover/fontLoader.js';

export interface BuildOptions {
  isoDate: string;
  timezone: string;
  author?: string;
  minChars: number;
  fonts: LoadedFont[];
  fetchPage?: PageFetcher;
  fetchImage?: typeof fetch;
}

export interface BuiltDigest {
  folder: string;
  epub: Buffer;
  filename: string;
  itemIds: string[];
}

interface ResolvedArticle {
  article: NormalizedArticle;
  source: ContentSource;
  failureReason: FailureReason;
  bodyXhtml: string;
  extractMs: number;
}

async function resolveContent(
  article: NormalizedArticle,
  minChars: number,
  fetchPage?: PageFetcher,
): Promise<ResolvedArticle> {
  const started = Date.now();
  if (inoreaderContentIsFull(article, minChars)) {
    return {
      article,
      source: 'inoreader',
      failureReason: null,
      bodyXhtml: sanitizeArticleHtml(article.inoreaderHtml),
      extractMs: Date.now() - started,
    };
  }
  const result = await extractFullText(article.url, fetchPage);
  return {
    article,
    source: 'readability',
    failureReason: result.failureReason,
    bodyXhtml: sanitizeArticleHtml(result.html),
    extractMs: Date.now() - started,
  };
}

/** Pick + process a grayscale cover background; undefined → crosshatch fallback. */
async function buildCoverImage(
  folder: string,
  articles: NormalizedArticle[],
  fetchImage: typeof fetch = fetch,
): Promise<EpubBinary | undefined> {
  const candidates = articles
    .map((a) => findCoverImageUrl(a.inoreaderHtml))
    .filter((u): u is string => Boolean(u));
  if (candidates.length === 0) return undefined;
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  try {
    const raw = await downloadImage(pick, fetchImage);
    const adjust = IMAGE_ADJUST[templateFor(folder)];
    const processed = await processCoverImage(raw, adjust);
    return {
      href: 'images/cover.jpg',
      data: processed.jpeg,
      mediaType: 'image/jpeg',
      isCover: true,
    };
  } catch {
    return undefined;
  }
}

/**
 * Build one folder's EPUB end-to-end and record diagnostics. Pure of network
 * effects except via injected fetchers; does not send or mark read.
 */
export async function buildFolderDigest(
  folder: string,
  articles: NormalizedArticle[],
  totalFetched: number,
  opts: BuildOptions,
  runLog?: RunLogRepo,
): Promise<BuiltDigest> {
  const startedAt = Date.now();
  const runId = runLog?.start(opts.isoDate, folder, totalFetched, articles.length);

  const dt = DateTime.fromISO(opts.isoDate, { zone: opts.timezone });
  const weekday = dt.toFormat('cccc');
  const dateLabel = dt.toFormat('LLLL d, yyyy');

  const resolved: ResolvedArticle[] = [];
  for (const article of articles) {
    resolved.push(await resolveContent(article, opts.minChars, opts.fetchPage));
  }

  // Build article pages + QR images.
  const epubArticles: EpubArticle[] = [];
  const images: EpubBinary[] = [];
  let idx = 0;
  for (const r of resolved) {
    idx += 1;
    const qrHref = `images/qr-${idx}.png`;
    const qr = await generateQrPng(r.article.url, { size: 220 });
    images.push({ href: qrHref, data: qr, mediaType: 'image/png' });

    epubArticles.push({
      id: `art-${idx}`,
      filename: `art-${idx}.xhtml`,
      title: r.article.title,
      xhtml: buildArticlePage({
        title: r.article.title,
        url: r.article.url,
        feedTitle: r.article.feedTitle,
        author: r.article.author,
        dateLabel: r.article.publishedMs
          ? DateTime.fromMillis(r.article.publishedMs).setZone(opts.timezone).toFormat('LLLL d, yyyy')
          : undefined,
        bodyXhtml: r.bodyXhtml,
        qrHref,
      }),
    });

    runLog?.addArticle(runId!, {
      itemId: r.article.itemId,
      title: r.article.title,
      url: r.article.url,
      contentSource: r.source,
      failureReason: r.failureReason,
      extractMs: r.extractMs,
    });
  }

  // Cover.
  const coverImage = await buildCoverImage(folder, articles, opts.fetchImage ?? fetch);
  if (coverImage) images.unshift(coverImage);
  const cover = renderCover({
    folder,
    weekday,
    isoDate: opts.isoDate,
    dateLabel,
    feeds: feedCounts(articles),
    backgroundImageHref: coverImage?.href,
  });

  // Diagnostics.
  const totalGenerationMs = Date.now() - startedAt;
  const diagnostics = buildDiagnosticsPage({
    folder,
    generatedAt: DateTime.now().setZone(opts.timezone).toFormat('yyyy-LL-dd HH:mm:ss ZZZZ'),
    totalFetched,
    included: articles.length,
    excluded: totalFetched - articles.length,
    totalGenerationMs,
    articles: resolved.map((r) => ({
      title: r.article.title,
      contentSource: r.source,
      failureReason: r.failureReason,
    })),
  });

  const epub = await buildEpub({
    identifier: `urn:kindle-digest:${folder}:${opts.isoDate}`,
    title: `${folder} — ${weekday} ${opts.isoDate}`,
    author: opts.author ?? 'Kindle Digest',
    date: opts.isoDate,
    series: { name: folder, index: opts.isoDate },
    coverXhtml: cover.xhtml,
    articles: epubArticles,
    diagnosticsXhtml: diagnostics,
    fonts: opts.fonts,
    images,
  });

  if (runId !== undefined) runLog?.finish(runId, 'sent', Date.now() - startedAt);

  const safeFolder = folder.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  return {
    folder,
    epub,
    filename: `${safeFolder}-${opts.isoDate}.epub`,
    itemIds: articles.map((a) => a.itemId),
  };
}
