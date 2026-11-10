import { createWriteStream } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import JSZip from 'jszip';
import { DateTime } from 'luxon';
import { renderCover } from '../cover/render.js';
import { buildCoverJpeg } from '../cover/composite.js';
import type { TemplateId } from '../cover/hash.js';
import { buildEpubToFile, type EpubArticle, type EpubBinary, type EpubFeedGroup } from '../epub/writer.js';
import { buildMasthead } from '../epub/masthead.js';
import { buildNcx } from '../epub/ncx.js';
import { buildSectionIndexPage } from '../epub/sectionIndex.js';
import { buildTocPage } from '../epub/toc.js';
import { escapeHtml } from '../util/html.js';

/**
 * Turning a directory into an EPUB.
 *
 * Two kinds of directory turn up:
 *  - an unpacked EPUB (has META-INF/container.xml): zipped as it is;
 *  - the `.staging-<folder>-<date>` directory an interrupted digest build leaves
 *    behind: only the article pages (`art-N.xhtml`) and their images (`images_*`,
 *    the `/` of the EPUB path turned into `_`). There is no OPF, contents page,
 *    cover or navigation, so those are rebuilt here from what the pages say about
 *    themselves, using the same builders as a live digest.
 */

export class ImportSourceError extends Error {}

const ARTICLE_FILE = /^art-(\d+)\.xhtml$/;
const STAGED_IMAGE = /^images_(.+\.(?:jpe?g|png))$/i;

/** Zip an unpacked EPUB directory: `mimetype` first and stored, everything else deflated. */
export async function zipEpubDir(dir: string, destEpub: string): Promise<void> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && path !== 'mimetype') zip.file(path, await readFile(join(dir, path)));
    }
  };
  await walk('');
  await pipeline(
    zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE' }),
    createWriteStream(destEpub),
  );
}

export type DirKind = 'epub' | 'staging';

/** What a directory holds, or throw ImportSourceError saying it is neither. */
export async function classifyDir(dir: string): Promise<DirKind> {
  const names = await readdir(dir);
  if (names.includes('META-INF') && names.includes('mimetype')) return 'epub';
  if (names.some((n) => ARTICLE_FILE.test(n))) return 'staging';
  throw new ImportSourceError(
    `${dir} is neither an unpacked EPUB (no META-INF/ + mimetype) nor a build staging directory (no art-N.xhtml pages)`,
  );
}

interface StagedArticle {
  n: number;
  file: string;
  title: string;
  feedIndex: number;
  feedTitle: string;
}

function decodeText(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

/** Read what the contents pages need (title, feed) out of one rendered article page. */
function parseArticle(n: number, file: string, xhtml: string): StagedArticle {
  const title = /<h1 class="article-title">([\s\S]*?)<\/h1>/.exec(xhtml)?.[1];
  const meta = /<div class="article-meta">([\s\S]*?)<\/div>/.exec(xhtml)?.[1];
  const feedIndex = /href="feed-(\d+)-index\.xhtml"/.exec(xhtml)?.[1];
  if (title === undefined || meta === undefined || feedIndex === undefined) {
    throw new ImportSourceError(`${file} is not a digest article page (no title, feed or section link)`);
  }
  // "<feed> · <author> · <date>": the feed is always first.
  const feedTitle = decodeText(meta.split(' · ')[0].trim());
  return {
    n,
    file,
    title: decodeText(title.trim()),
    feedIndex: Number(feedIndex),
    feedTitle: feedTitle || 'Articles',
  };
}

const mediaTypeOf = (name: string): string => (/\.png$/i.test(name) ? 'image/png' : 'image/jpeg');

const DISABLED_PREV = '<span class="nav-disabled">&#x25C0; Prev</span>';
const DISABLED_NEXT = '<span class="nav-disabled">Next &#x25B6;</span>';

/**
 * Make a page safe to ship when pieces of the build are missing: images that
 * were never staged are dropped, and Prev/Next links to articles that are not
 * there become the greyed-out "no more" marker, so the EPUB has no dangling
 * references.
 */
function repairPage(
  xhtml: string,
  haveImages: Set<string>,
  haveArticles: Set<number>,
): { xhtml: string; droppedImages: number } {
  let droppedImages = 0;
  let out = xhtml.replace(/<img\b[^>]*?\bsrc="(images\/[^"]+)"[^>]*>/g, (tag, src: string) => {
    if (haveImages.has(src)) return tag;
    droppedImages += 1;
    return '';
  });
  out = out.replace(/<a href="art-(\d+)\.xhtml">(&#x25C0; Prev|Next &#x25B6;)<\/a>/g, (tag, id: string, label: string) =>
    haveArticles.has(Number(id)) ? tag : label.endsWith('Prev') ? DISABLED_PREV : DISABLED_NEXT,
  );
  return { xhtml: out, droppedImages };
}

export interface StagingOptions {
  folder: string;
  isoDate: string;
  /** Cover look; the folder's own settings when it has any. */
  coverTemplate?: TemplateId | null;
  coverTheme?: 'light' | 'dark';
  /** Embedded fonts, as for a live digest. */
  fonts?: { file: string; data: Buffer }[];
  /** Scratch directory for the cover and masthead images (same volume as the output is best). */
  scratchDir: string;
}

export interface StagingResult {
  articles: number;
  /** Article numbers missing from the sequence (their pages were never staged). */
  missingArticles: number[];
  /** Image tags removed because the picture was not in the staging directory. */
  droppedImages: number;
}

/** Rebuild a digest EPUB from a build staging directory. */
export async function buildEpubFromStaging(
  dir: string,
  destEpub: string,
  opts: StagingOptions,
): Promise<StagingResult> {
  const names = await readdir(dir);
  const articleNums = names
    .map((n) => ARTICLE_FILE.exec(n))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
  if (articleNums.length === 0) throw new ImportSourceError(`${dir} has no art-N.xhtml pages`);

  const haveArticles = new Set(articleNums);
  const images: EpubBinary[] = [];
  const haveImages = new Set<string>();
  for (const name of names) {
    const m = STAGED_IMAGE.exec(name);
    if (!m) continue;
    const href = `images/${m[1]}`;
    haveImages.add(href);
    images.push({ href, path: join(dir, name), mediaType: mediaTypeOf(name) });
  }

  // Pages are read one at a time for their facts; the (repaired) text is only
  // kept when it had to change, otherwise the file is streamed into the zip.
  const staged: StagedArticle[] = [];
  const repaired = new Map<number, string>();
  let droppedImages = 0;
  for (const n of articleNums) {
    const file = `art-${n}.xhtml`;
    const raw = await readFile(join(dir, file), 'utf8');
    staged.push(parseArticle(n, file, raw));
    const fixed = repairPage(raw, haveImages, haveArticles);
    if (fixed.xhtml !== raw) {
      repaired.set(n, fixed.xhtml);
      droppedImages += fixed.droppedImages;
    }
  }

  const epubArticles: EpubArticle[] = staged.map((a) => ({
    id: `art-${a.n}`,
    filename: a.file,
    title: a.title,
    ...(repaired.has(a.n) ? { xhtml: repaired.get(a.n) } : { path: join(dir, a.file) }),
  }));

  // Sections follow the pages' own `feed-K-index` links, in order of K.
  const byFeed = new Map<number, StagedArticle[]>();
  for (const a of staged) byFeed.set(a.feedIndex, [...(byFeed.get(a.feedIndex) ?? []), a]);
  const feedGroups: EpubFeedGroup[] = [...byFeed.entries()]
    .sort(([x], [y]) => x - y)
    .map(([k, list]) => ({
      feedTitle: list[0].feedTitle,
      filename: `feed-${k}-index.xhtml`,
      xhtml: buildSectionIndexPage(
        list[0].feedTitle,
        list.map((a) => ({ filename: a.file, title: a.title })),
      ),
      articleIds: list.map((a) => `art-${a.n}`),
    }));
  // The spine follows the sections, so number the pages in that order.
  const ordered = feedGroups.flatMap((g) =>
    g.articleIds.map((id) => epubArticles.find((a) => a.id === id)!),
  );

  const ncxXml = buildNcx(
    opts.folder,
    feedGroups.map((g) => ({
      feedTitle: g.feedTitle,
      sectionFilename: g.filename,
      articles: g.articleIds.map((id) => {
        const a = epubArticles.find((x) => x.id === id)!;
        return { id: a.id, filename: a.filename, title: a.title };
      }),
    })),
  );
  const tocXhtml = buildTocPage(
    ordered.map((a) => ({
      filename: a.filename,
      title: a.title,
      feedTitle: staged.find((s) => s.file === a.filename)!.feedTitle,
    })),
  );

  // Cover and masthead, the same way a live digest makes them.
  const dt = DateTime.fromISO(opts.isoDate, { zone: 'utc' });
  const coverInput = {
    folder: opts.folder,
    weekday: dt.toFormat('cccc'),
    isoDate: opts.isoDate,
    dateLabel: dt.toFormat('LLLL d, yyyy'),
    feeds: feedGroups
      .map((g) => ({ name: g.feedTitle, count: g.articleIds.length }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  };
  // Background photo: the first picture of the first article that has one.
  const photo = [...haveImages].filter((h) => /^images\/art-\d+-img-\d+\.jpe?g$/i.test(h)).sort(
    (a, b) => artNumOf(a) - artNumOf(b) || a.localeCompare(b),
  )[0];
  const coverJpeg = await buildCoverJpeg(
    coverInput,
    photo ? await readFile(join(dir, photo.replace('/', '_'))) : undefined,
    opts.coverTemplate ?? null,
    opts.coverTheme ?? 'dark',
  );
  const cover = renderCover(coverInput, opts.coverTemplate ?? null);
  const masthead = await buildMasthead(opts.folder);
  const coverPath = join(opts.scratchDir, 'cover.jpg');
  const mastheadPath = join(opts.scratchDir, 'masthead.jpg');
  await writeFile(coverPath, coverJpeg);
  await writeFile(mastheadPath, masthead);
  images.unshift({ href: 'images/cover.jpg', path: coverPath, mediaType: 'image/jpeg', isCover: true });
  images.push({ href: 'images/masthead.jpg', path: mastheadPath, mediaType: 'image/jpeg' });

  await buildEpubToFile(
    {
      identifier: `urn:kindle-digest:${opts.folder}:${opts.isoDate}`,
      title: opts.folder,
      author: 'Kindle Digest',
      date: opts.isoDate,
      series: { name: opts.folder, index: opts.isoDate },
      coverXhtml: cover.xhtml,
      tocXhtml,
      articles: ordered,
      diagnosticsXhtml: diagnosticsPage(opts, staged.length, articleNums, droppedImages),
      fonts: opts.fonts ?? [],
      images,
      feedGroups,
      ncxXml,
    },
    destEpub,
  );
  await stat(destEpub);

  const last = articleNums[articleNums.length - 1];
  const missingArticles: number[] = [];
  for (let i = 1; i <= last; i++) if (!haveArticles.has(i)) missingArticles.push(i);
  return { articles: staged.length, missingArticles, droppedImages };
}

function artNumOf(href: string): number {
  return Number(/art-(\d+)-img/.exec(href)?.[1] ?? Number.MAX_SAFE_INTEGER);
}

function diagnosticsPage(
  opts: StagingOptions,
  count: number,
  nums: number[],
  droppedImages: number,
): string {
  const last = nums[nums.length - 1];
  const gaps = last - count;
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
  <meta charset="utf-8" />
  <title>Diagnostics</title>
  <link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
  <h1>Diagnostics</h1>
  <p>${escapeHtml(opts.folder)} — ${escapeHtml(opts.isoDate)}. Rebuilt from the article pages an interrupted
  build left behind: ${count} articles${gaps > 0 ? `, ${gaps} numbered pages missing` : ''}${droppedImages > 0 ? `, ${droppedImages} missing pictures left out` : ''}.</p>
</body>
</html>`;
}
