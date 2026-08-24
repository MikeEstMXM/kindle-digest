import { DateTime } from 'luxon';
import { join } from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
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
import {
  buildEpubToFile,
  type EpubArticle,
  type EpubBinary,
  type EpubFeedGroup,
} from '../epub/writer.js';
import { buildDiagnosticsPage } from '../diagnostics/build.js';
import { feedCounts } from './grouping.js';
import type { LoadedFont } from '../cover/fontLoader.js';
import type { TemplateId } from '../cover/hash.js';
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
  /** Directory the built .epub is streamed into (lives on the Fly volume). */
  outDir: string;
  fetchPage?: PageFetcher;
  fetchImage?: typeof fetch;
  coverTemplate?: TemplateId | null;
  coverTheme?: 'light' | 'dark';
}

export interface BuiltDigest {
  folder: string;
  /** Absolute path to the built .epub on disk. */
  epubPath: string;
  epubBytes: number;
  /** Attachment filename presented to the mail client. */
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
  // Image-primary comics (XKCD, SMBC) have an <img> and short surrounding text
  // (hovertext / "click for bonus panel"). The feed content IS the full article.
  // Threshold 350: covers SMBC's longest hover-text jokes without misclassifying
  // real text articles (which typically provide ≥400-char excerpts in the feed).
  const hasImages = /<img\b/i.test(article.contentHtml);
  const isImageOnly = hasImages && article.contentTextLength < 350;
  if (contentIsFull(article, minChars) || isImageOnly) {
    const { xhtml, imageUrls } = sanitizeArticleHtml(article.contentHtml);
    return { article, source: 'feed', failureReason: null, bodyXhtml: xhtml, imageUrls, extractMs: Date.now() - started };
  }
  const result = await extractFullText(article.url, fetchPage);
  // Safety net: if Readability failed and the feed already has an image, the
  // feed content is the best we have (image-primary page Readability can't parse).
  if (result.failureReason !== null && hasImages) {
    const { xhtml, imageUrls } = sanitizeArticleHtml(article.contentHtml);
    return { article, source: 'feed', failureReason: null, bodyXhtml: xhtml, imageUrls, extractMs: Date.now() - started };
  }
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
  try {
    const built = await buildFolderDigestInner(
      folder,
      articles,
      totalFetched,
      startedAt,
      opts,
      runLog,
      runId,
    );
    // 'built' means an EPUB exists on disk — delivery.state is the authority
    // on whether it was actually mailed.
    if (runId !== undefined) runLog?.finish(runId, 'built', Date.now() - startedAt);
    return built;
  } catch (err) {
    // Previously any throw here left the row stuck at 'running' forever with a
    // NULL error, which is why failures were undiagnosable.
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    if (runId !== undefined) runLog?.finish(runId, 'error', Date.now() - startedAt, message);
    throw err;
  }
}

async function buildFolderDigestInner(
  folder: string,
  articles: NormalizedArticle[],
  totalFetched: number,
  startedAt: number,
  opts: BuildOptions,
  runLog: RunLogRepo | undefined,
  runId: number | undefined,
): Promise<BuiltDigest> {
  const dt = DateTime.fromISO(opts.isoDate, { zone: opts.timezone });
  const weekday = dt.toFormat('cccc');
  const dateLabel = dt.toFormat('LLLL d, yyyy');

  // Images are written here as they are produced and streamed into the zip at
  // the end. Keeping them as Buffers made peak memory grow with article count
  // (~0.75 MB/article measured), which is what broke long digests.
  const safeFolder = folder.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const stagingDir = join(opts.outDir, `.staging-${safeFolder}-${opts.isoDate}`);
  await mkdir(stagingDir, { recursive: true });
  const stage = async (href: string, data: Buffer): Promise<string> => {
    const path = join(stagingDir, href.replace(/\//g, '_'));
    await writeFile(path, data);
    return path;
  };

  try {
    return await assembleDigest();
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }

  // eslint-disable-next-line no-inner-declarations
  async function assembleDigest(): Promise<BuiltDigest> {
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
    images.push({ href: qrHref, path: await stage(qrHref, qr), mediaType: 'image/png' });

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
        images.push({
          href: imgHref,
          path: await stage(imgHref, processed.jpeg),
          mediaType: 'image/jpeg',
        });
        bodyXhtml = bodyXhtml.replace(`%%img-${i}%%`, imgHref);
      } catch {
        bodyXhtml = bodyXhtml.replace(
          new RegExp(`<img[^>]*src="%%img-${i}%%"[^>]*\\/>`, 'g'),
          '',
        );
      }
    }

    const pageXhtml = buildArticlePage({
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
    });
    epubArticles.push({
      id: `art-${idx}`,
      filename: artFilename,
      title: r.article.title,
      path: await stage(artFilename, Buffer.from(pageXhtml, 'utf8')),
    });
    // The rendered page is on disk now, and the extracted body is not needed
    // again — releasing both keeps heap flat across a long digest.
    r.bodyXhtml = '';

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
    opts.coverTemplate,
    opts.coverTheme,
  );
  images.unshift({
    href: 'images/cover.jpg',
    path: await stage('images/cover.jpg', coverJpeg),
    mediaType: 'image/jpeg',
    isCover: true,
  });
  const cover = renderCover(
    { folder, weekday, isoDate: opts.isoDate, dateLabel, feeds: feedCounts(articles) },
    opts.coverTemplate,
  );

  // Masthead image (600×60 for Kindle periodical display).
  const mastheadBuffer = await buildMasthead(folder);
  images.push({
    href: 'images/masthead.jpg',
    path: await stage('images/masthead.jpg', mastheadBuffer),
    mediaType: 'image/jpeg',
  });

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

  const filename = `${safeFolder}.epub`;
  const epubPath = join(opts.outDir, `${safeFolder}-${opts.isoDate}.epub`);

  // Streamed straight to the volume: keeps the archive out of the heap and
  // leaves a retryable artifact behind, so a failed send never rebuilds.
  const epubBytes = await buildEpubToFile(
    {
      identifier: `urn:kindle-digest:${folder}:${opts.isoDate}`,
      title: folder,
      author: opts.author ?? 'Kindle Digest',
      date: opts.isoDate,
      series: { name: folder, index: opts.isoDate },
      coverXhtml: cover.xhtml,
      tocXhtml,
      articles: epubArticles,
      diagnosticsXhtml: diagnostics,
      fonts: opts.fonts,
      images,
      feedGroups,
      ncxXml,
    },
    epubPath,
  );

  return {
    folder,
    epubPath,
    epubBytes,
    filename,
    itemIds: articles.map((a) => a.itemId),
  };
  }
}
