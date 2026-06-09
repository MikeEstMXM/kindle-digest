import JSZip from 'jszip';
import { buildNav, buildOpf, CONTAINER_XML, type ManifestItem, type NavEntry } from './opf.js';
import { contentCss } from './css.js';
import type { NcxSection } from './ncx.js';

export interface EpubArticle {
  /** Stable id used in manifest/spine, e.g. "art-1". */
  id: string;
  /** File name within OEBPS, e.g. "art-1.xhtml". */
  filename: string;
  /** Nav label (article title). */
  title: string;
  xhtml: string;
}

export interface EpubBinary {
  /** href relative to OEBPS, e.g. "images/cover.jpg". */
  href: string;
  data: Buffer;
  mediaType: string;
  /** Mark as the EPUB cover-image (library thumbnail). At most one. */
  isCover?: boolean;
}

export interface EpubFeedGroup {
  /** Feed name shown in section index and NCX. */
  feedTitle: string;
  /** Filename of the section index page, e.g. "feed-0-index.xhtml". */
  filename: string;
  /** XHTML content of the section index page. */
  xhtml: string;
  /** IDs of EpubArticle entries belonging to this section (in order). */
  articleIds: string[];
}

export interface EpubInput {
  identifier: string;
  /** Publication name only — no date in the title. */
  title: string;
  author: string;
  language?: string;
  /** ISO date string. */
  date: string;
  coverXhtml: string;
  tocXhtml: string;
  articles: EpubArticle[];
  diagnosticsXhtml: string;
  fonts: { file: string; data: Buffer }[];
  images: EpubBinary[];
  /** Feed section index pages + grouping for NCX and spine ordering. */
  feedGroups?: EpubFeedGroup[];
  /** Pre-built NCX 2.0 XML string for Kindle periodical navigation. */
  ncxXml?: string;
  /** Series name + index for Kindle collection grouping (belongs-to-collection). */
  series?: { name: string; index: string };
}

const COVER_ID = 'cover-page';
const TOC_ID = 'toc';
const DIAG_ID = 'diagnostics';
const NCX_ID = 'ncx';

/** Assemble the manifest + spine for an EPUB (pure, unit-testable). */
export function buildManifestAndSpine(input: EpubInput): {
  manifest: ManifestItem[];
  spine: string[];
  nav: NavEntry[];
  ncxSections: NcxSection[];
  firstArticleFilename: string | undefined;
} {
  const manifest: ManifestItem[] = [
    { id: 'nav', href: 'nav.xhtml', mediaType: 'application/xhtml+xml', properties: 'nav' },
    { id: 'style', href: 'style.css', mediaType: 'text/css' },
    { id: COVER_ID, href: 'cover.xhtml', mediaType: 'application/xhtml+xml' },
    { id: TOC_ID, href: 'toc.xhtml', mediaType: 'application/xhtml+xml' },
  ];

  if (input.ncxXml) {
    manifest.push({ id: NCX_ID, href: 'toc.ncx', mediaType: 'application/x-dtbncx+xml' });
  }

  const articleById = new Map(input.articles.map((a) => [a.id, a]));

  if (input.feedGroups && input.feedGroups.length > 0) {
    // Add section index pages + articles in feed-grouped order.
    for (const group of input.feedGroups) {
      manifest.push({ id: `section-${group.filename.replace(/[^a-z0-9]/gi, '-')}`, href: group.filename, mediaType: 'application/xhtml+xml' });
      for (const id of group.articleIds) {
        const a = articleById.get(id)!;
        manifest.push({ id: a.id, href: a.filename, mediaType: 'application/xhtml+xml' });
      }
    }
  } else {
    for (const a of input.articles) {
      manifest.push({ id: a.id, href: a.filename, mediaType: 'application/xhtml+xml' });
    }
  }

  manifest.push({ id: DIAG_ID, href: 'diagnostics.xhtml', mediaType: 'application/xhtml+xml' });

  for (const f of input.fonts) {
    manifest.push({
      id: `font-${f.file.replace(/[^a-z0-9]/gi, '-')}`,
      href: `fonts/${f.file}`,
      mediaType: 'font/woff2',
    });
  }
  for (const [i, img] of input.images.entries()) {
    manifest.push({
      id: `img-${i}`,
      href: img.href,
      mediaType: img.mediaType,
      properties: img.isCover ? 'cover-image' : undefined,
    });
  }

  // Spine: cover, master ToC, then [section index, articles...] per feed, diagnostics last.
  const spine: string[] = [COVER_ID, TOC_ID];
  let firstArticleFilename: string | undefined;

  if (input.feedGroups && input.feedGroups.length > 0) {
    for (const group of input.feedGroups) {
      spine.push(`section-${group.filename.replace(/[^a-z0-9]/gi, '-')}`);
      for (const id of group.articleIds) {
        const a = articleById.get(id)!;
        if (!firstArticleFilename) firstArticleFilename = a.filename;
        spine.push(a.id);
      }
    }
  } else {
    for (const a of input.articles) {
      if (!firstArticleFilename) firstArticleFilename = a.filename;
      spine.push(a.id);
    }
  }
  spine.push(DIAG_ID);

  // EPUB3 nav: flat list of all articles for nav.xhtml.
  const nav: NavEntry[] = [
    { href: 'toc.xhtml', label: 'Contents' },
    ...input.articles.map((a) => ({ href: a.filename, label: a.title })),
    { href: 'diagnostics.xhtml', label: 'Diagnostics' },
  ];

  // NCX sections for buildNcx (mirrored from feedGroups).
  const ncxSections: NcxSection[] = (input.feedGroups ?? []).map((g) => ({
    feedTitle: g.feedTitle,
    sectionFilename: g.filename,
    articles: g.articleIds.map((id) => {
      const a = articleById.get(id)!;
      return { id: a.id, filename: a.filename, title: a.title };
    }),
  }));

  return { manifest, spine, nav, ncxSections, firstArticleFilename };
}

/** Produce the .epub as a Buffer. */
export async function buildEpub(input: EpubInput): Promise<Buffer> {
  const { manifest, spine, nav, firstArticleFilename } = buildManifestAndSpine(input);
  const language = input.language ?? 'en';
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  // Find masthead in images list (added by orchestrator as images/masthead.jpg).
  const hasMasthead = input.images.some((img) => img.href === 'images/masthead.jpg');

  const opf = buildOpf({
    identifier: input.identifier,
    title: input.title,
    language,
    author: input.author,
    date: input.date,
    modified,
    manifest,
    spine,
    series: input.series,
    ncxId: input.ncxXml ? NCX_ID : undefined,
    guide:
      hasMasthead && firstArticleFilename
        ? {
            coverHref: 'cover.xhtml',
            mastheadHref: 'images/masthead.jpg',
            tocHref: 'toc.xhtml',
            startHref: firstArticleFilename,
          }
        : undefined,
  });

  const zip = new JSZip();
  // mimetype MUST be first and stored uncompressed.
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', CONTAINER_XML);

  const oebps = zip.folder('OEBPS')!;
  oebps.file('content.opf', opf);
  oebps.file('nav.xhtml', buildNav(input.title, nav));
  oebps.file('style.css', contentCss());
  oebps.file('cover.xhtml', input.coverXhtml);
  oebps.file('toc.xhtml', input.tocXhtml);
  oebps.file('diagnostics.xhtml', input.diagnosticsXhtml);
  for (const a of input.articles) oebps.file(a.filename, a.xhtml);
  if (input.feedGroups) {
    for (const g of input.feedGroups) oebps.file(g.filename, g.xhtml);
  }
  if (input.ncxXml) oebps.file('toc.ncx', input.ncxXml);
  for (const f of input.fonts) oebps.file(`fonts/${f.file}`, f.data);
  for (const img of input.images) oebps.file(img.href, img.data);

  return zip.generateAsync({
    type: 'nodebuffer',
    mimeType: 'application/epub+zip',
    compression: 'DEFLATE',
  });
}
