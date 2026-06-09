import { DateTime } from 'luxon';
import type { NormalizedArticle } from '../reader/types.js';
import type { RunLogRepo } from '../db/repositories.js';
import { contentIsFull, type ContentSource, type FailureReason } from '../content/fulltext.js';
import { extractFullText, type PageFetcher } from '../content/extract.js';
import { sanitizeArticleHtml } from '../content/sanitize.js';
import { downloadImage, findCoverImageUrl } from '../content/images.js';
import { buildCoverJpeg } from '../cover/composite.js';
import { buildMastheadJpeg } from '../calibre/masthead.js';
import { buildRecipeDir } from '../calibre/recipe.js';
import { buildCalibreEpub } from '../calibre/convert.js';
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
  imageUrls: string[];
  extractMs: number;
}

async function resolveContent(
  article: NormalizedArticle,
  minChars: number,
  fetchPage?: PageFetcher,
): Promise<ResolvedArticle> {
  const started = Date.now();
  if (contentIsFull(article, minChars)) {
    const { xhtml, imageUrls } = sanitizeArticleHtml(article.contentHtml);
    return { article, source: 'feed', failureReason: null, bodyXhtml: xhtml, imageUrls, extractMs: Date.now() - started };
  }
  const result = await extractFullText(article.url, fetchPage);
  const { xhtml, imageUrls } = sanitizeArticleHtml(result.html);
  return { article, source: 'readability', failureReason: result.failureReason, bodyXhtml: xhtml, imageUrls, extractMs: Date.now() - started };
}

/** Download raw background image for compositing; returns undefined on any error. */
async function downloadRawCoverImage(
  articles: NormalizedArticle[],
  fetchImage: typeof fetch = fetch,
): Promise<Buffer | undefined> {
  const candidates = articles
    .map((a) => findCoverImageUrl(a.contentHtml))
    .filter((u): u is string => Boolean(u));
  if (candidates.length === 0) return undefined;
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  try {
    return await downloadImage(pick, fetchImage);
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

  // Log all articles to the run log.
  for (const r of resolved) {
    runLog?.addArticle(runId!, {
      itemId: r.article.itemId,
      title: r.article.title,
      url: r.article.url,
      contentSource: r.source,
      failureReason: r.failureReason,
      extractMs: r.extractMs,
    });
  }

  // Cover — Sharp-composited JPEG with SVG overlay.
  const rawCoverImage = await downloadRawCoverImage(articles, opts.fetchImage ?? fetch);
  const coverJpeg = await buildCoverJpeg(
    { folder, weekday, isoDate: opts.isoDate, dateLabel, feeds: feedCounts(articles) },
    rawCoverImage,
    opts.fonts,
  );

  // Calibre periodical pipeline: recipe dir → ebook-convert → EPUB buffer.
  const mastheadJpeg = await buildMastheadJpeg(folder);
  const recipeDir = buildRecipeDir(
    {
      folder,
      isoDate: opts.isoDate,
      dateLabel,
      articles: resolved.map((r) => ({
        title: r.article.title,
        feedTitle: r.article.feedTitle,
        url: r.article.url,
        author: r.article.author,
        publishedMs: r.article.publishedMs,
        bodyHtml: r.bodyXhtml,
      })),
    },
    coverJpeg,
    mastheadJpeg,
  );
  const epub = await buildCalibreEpub(recipeDir);
  const totalGenerationMs = Date.now() - startedAt;

  if (runId !== undefined) runLog?.finish(runId, 'sent', totalGenerationMs);

  const safeFolder = folder.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  return {
    folder,
    epub,
    filename: `${safeFolder}-${opts.isoDate}.epub`,
    itemIds: articles.map((a) => a.itemId),
  };
}
