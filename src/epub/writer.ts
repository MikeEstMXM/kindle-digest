import JSZip from 'jszip';
import { buildNav, buildOpf, CONTAINER_XML, type ManifestItem, type NavEntry } from './opf.js';
import { contentCss } from './css.js';

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

export interface EpubInput {
  identifier: string;
  title: string;
  author: string;
  language?: string;
  /** ISO date string; series index. */
  date: string;
  series: { name: string; index: string };
  coverXhtml: string;
  tocXhtml: string;
  articles: EpubArticle[];
  diagnosticsXhtml: string;
  fonts: { file: string; data: Buffer }[];
  images: EpubBinary[];
}

const COVER_ID = 'cover-page';
const TOC_ID = 'toc';
const DIAG_ID = 'diagnostics';

/** Assemble the manifest + spine for an EPUB (pure, unit-testable). */
export function buildManifestAndSpine(input: EpubInput): {
  manifest: ManifestItem[];
  spine: string[];
  nav: NavEntry[];
} {
  const manifest: ManifestItem[] = [
    { id: 'nav', href: 'nav.xhtml', mediaType: 'application/xhtml+xml', properties: 'nav' },
    { id: 'style', href: 'style.css', mediaType: 'text/css' },
    { id: COVER_ID, href: 'cover.xhtml', mediaType: 'application/xhtml+xml' },
    { id: TOC_ID, href: 'toc.xhtml', mediaType: 'application/xhtml+xml' },
  ];

  for (const a of input.articles) {
    manifest.push({ id: a.id, href: a.filename, mediaType: 'application/xhtml+xml' });
  }
  manifest.push({
    id: DIAG_ID,
    href: 'diagnostics.xhtml',
    mediaType: 'application/xhtml+xml',
  });

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

  // Spine: cover, ToC, then articles, diagnostics last.
  const spine = [COVER_ID, TOC_ID, ...input.articles.map((a) => a.id), DIAG_ID];

  const nav: NavEntry[] = [
    { href: 'toc.xhtml', label: 'Contents' },
    ...input.articles.map((a) => ({ href: a.filename, label: a.title })),
    { href: 'diagnostics.xhtml', label: 'Diagnostics' },
  ];

  return { manifest, spine, nav };
}

/** Produce the .epub as a Buffer. */
export async function buildEpub(input: EpubInput): Promise<Buffer> {
  const { manifest, spine, nav } = buildManifestAndSpine(input);
  const language = input.language ?? 'en';
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const opf = buildOpf({
    identifier: input.identifier,
    title: input.title,
    language,
    author: input.author,
    date: input.date,
    modified,
    series: input.series,
    manifest,
    spine,
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
  for (const f of input.fonts) oebps.file(`fonts/${f.file}`, f.data);
  for (const img of input.images) oebps.file(img.href, img.data);

  return zip.generateAsync({
    type: 'nodebuffer',
    mimeType: 'application/epub+zip',
    compression: 'DEFLATE',
  });
}
