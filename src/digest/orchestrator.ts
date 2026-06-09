import { DateTime } from 'luxon';
import type { NormalizedArticle } from '../reader/types.js';
import type { RunLogRepo } from '../db/repositories.js';
import { contentIsFull, type ContentSource, type FailureReason } from '../content/fulltext.js';
import { extractFullText, type PageFetcher } from '../content/extract.js';
import { sanitizeArticleHtml } from '../content/sanitize.js';
import { generateQrPng } from '../content/qr.js';
import {
  downloadImage,
  findCoverImageUrl,
  processArticleImage,
} from '../content/images.js';
import { renderCover } from '../cover/render.js';
import { buildCoverJpeg } from '../cover/composite.js';
import { buildArticlePage } from '../epub/article.js';
import { buildTocPage } from '../epub/toc.js';
import { buildEpub, type EpubArticle, type EpubBinary, type EpubFeedGroup } from '../epub/writer.js';
import { buildDiagnosticsPage } from '../diagnostics/build.js';
import { feedCounts } from './grouping.js';
import type { LoadedFont } from '../cover/fontLoader.js';
import { buildNcx } from '../epub/ncx.js';
import { buildMasthead } from '../epub/masthead.js';
import { buildSectionIndexPage } from '../epub/sectionIndex.js';
import { htmlToText } from '../util/html.js';

const MAX_IMAGES_PER_ARTICLE = 5;
// Gallery threshold: more than 1 image per 100 words with at least 6 images → skip all images.
const GALLERY_IMAGE_RATIO = 100;

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

  // Pre-compute feed section ordering for NCX and nav bars.
  const feedOrder: string[] = [];
  const feedIndexMap = new Map<string, number>(); // feedTitle → feedIdx
  for (const r of resolved) {
    if (!feedIndexMap.has(r.article.feedTitle)) {
      feedIndexMap.set(r.article.feedTitle, feedOrder.length);
      feedOrder.push(r.article.feedTitle);
    }
  }
  // Articles grouped by feedIdx (preserving insertion order within each feed).
  const feedArticleIndices = new Map<number, number[]>();
  for (let i = 0; i < resolved.length; i++) {
    const fi = feedIndexMap.get(resolved[i].article.feedTitle)!;
    if (!feedArticleIndices.has(fi)) feedArticleIndices.set(fi, []);
    feedArticleIndices.get(fi)!.push(i);
  }

  // Build article pages + QR images + inline article images.
  const epubArticles: EpubArticle[] = [];
  const images: EpubBinary[] = [];
  let idx = 0;
  for (const r of resolved) {
    idx += 1;
    const artFilename = `art-${idx}.xhtml`;
    const feedIdx = feedIndexMap.get(r.article.feedTitle)!;
    const sectionFilename = `feed-${feedIdx}-index.xhtml`;

    // Compute prev/next within this feed section.
    const sectionIndices = feedArticleIndices.get(feedIdx)!;
    const posInSection = sectionIndices.indexOf(idx - 1);
    const prevFilename =
      posInSection > 0 ? `art-${sectionIndices[posInSection - 1] + 1}.xhtml` : null;
    const nextFilename =
      posInSection < sectionIndices.length - 1
        ? `art-${sectionIndices[posInSection + 1] + 1}.xhtml`
        : null;

    const qrHref = `images/qr-${idx}.png`;
    const qr = await generateQrPng(r.article.url, { size: 220 });
    images.push({ href: qrHref, data: qr, mediaType: 'image/png' });

    // Download + embed inline article images; substitute or strip placeholders.
    // Cap images per article; skip all images for gallery-type pages.
    const wordCount = htmlToText(r.bodyXhtml).split(/\s+/).filter(Boolean).length;
    const isGallery =
      r.imageUrls.length > MAX_IMAGES_PER_ARTICLE &&
      r.imageUrls.length * GALLERY_IMAGE_RATIO > wordCount;
    const imageLimit = isGallery ? 0 : MAX_IMAGES_PER_ARTICLE;

    let bodyXhtml = r.bodyXhtml;
    for (let i = 0; i < r.imageUrls.length; i++) {
      if (i >= imageLimit) {
        // Strip placeholder — beyond cap or gallery page.
        bodyXhtml = bodyXhtml.replace(
          new RegExp(`<img[^>]*src="%%img-${i}%%"[^>]*\\/>`, 'g'),
          '',
        );
        continue;
      }
      const imgHref = `images/art-${idx}-img-${i}.jpg`;
      try {
        const raw = await downloadImage(r.imageUrls[i], opts.fetchImage ?? fetch);
        const processed = await processArticleImage(raw);
        images.push({ href: imgHref, data: processed.jpeg, mediaType: 'image/jpeg' });
        bodyXhtml = bodyXhtml.replace(`%%img-${i}%%`, imgHref);
      } catch {
        bodyXhtml = bodyXhtml.replace(
          new RegExp(`<img[^>]*src="%%img-${i}%%"[^>]*\\/>`, 'g'),
          '',
        );
      }
    }

    epubArticles.push({
      id: `art-${idx}`,
      filename: artFilename,
      title: r.article.title,
      xhtml: buildArticlePage({
        title: r.article.title,
        url: r.article.url,
        feedTitle: r.article.feedTitle,
        author: r.article.author,
        dateLabel: r.article.publishedMs
          ? DateTime.fromMillis(r.article.publishedMs).setZone(opts.timezone).toFormat('LLLL d, yyyy')
          : undefined,
        bodyXhtml,
        qrHref,
        navBar: { prevHref: prevFilename, nextHref: nextFilename, sectionHref: sectionFilename },
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

  // Table of contents.
  const tocXhtml = buildTocPage(
    epubArticles.map((a, i) => ({
      filename: a.filename,
      title: a.title,
      feedTitle: resolved[i].article.feedTitle,
    })),
  );

  // Cover — Sharp-composited 1600×2400 JPEG with SVG overlay.
  const rawCoverImage = await downloadRawCoverImage(articles, opts.fetchImage ?? fetch);
  const coverJpeg = await buildCoverJpeg(
    { folder, weekday, isoDate: opts.isoDate, dateLabel, feeds: feedCounts(articles) },
    rawCoverImage,
    opts.fonts,
  );
  images.unshift({ href: 'images/cover.jpg', data: coverJpeg, mediaType: 'image/jpeg', isCover: true });
  const cover = renderCover({ folder, weekday, isoDate: opts.isoDate, dateLabel, feeds: feedCounts(articles) });

  // Masthead image (600×60 for Kindle periodical display).
  const mastheadBuffer = await buildMasthead(folder);
  images.push({ href: 'images/masthead.jpg', data: mastheadBuffer, mediaType: 'image/jpeg' });

  // Feed section index pages + groups for NCX spine ordering.
  const feedGroups: EpubFeedGroup[] = feedOrder.map((feedTitle, fi) => {
    const sectionFilename = `feed-${fi}-index.xhtml`;
    const sectionArticleIndices = feedArticleIndices.get(fi)!;
    const sectionArticles = sectionArticleIndices.map((i) => epubArticles[i]);
    return {
      feedTitle,
      filename: sectionFilename,
      xhtml: buildSectionIndexPage(
        feedTitle,
        sectionArticles.map((a) => ({ filename: a.filename, title: a.title })),
      ),
      articleIds: sectionArticles.map((a) => a.id),
    };
  });

  // NCX 2.0 for Kindle periodical navigation (3-level: periodical → section → article).
  const ncxXml = buildNcx(folder, feedGroups.map((g) => ({
    feedTitle: g.feedTitle,
    sectionFilename: g.filename,
    articles: g.articleIds.map((id) => {
      const a = epubArticles.find((ea) => ea.id === id)!;
      return { id: a.id, filename: a.filename, title: a.title };
    }),
  })));

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
    title: folder,
    author: opts.author ?? 'Kindle Digest',
    date: opts.isoDate,
    coverXhtml: cover.xhtml,
    tocXhtml,
    articles: epubArticles,
    diagnosticsXhtml: diagnostics,
    fonts: opts.fonts,
    images,
    feedGroups,
    ncxXml,
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
