import { escapeHtml } from '../util/html.js';

export interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties?: string;
}

export interface OpfGuide {
  mastheadHref: string;
  tocHref: string;
  startHref: string;
}

export interface OpfInput {
  identifier: string;
  title: string;
  language: string;
  author: string;
  /** ISO date string. */
  date: string;
  modified: string; // ISO 8601 dcterms:modified
  /** index must be a numeric string (YYYYMMDD) — Kindle requires numeric group-position for series stacking. */
  series: { name: string; index: string };
  manifest: ManifestItem[];
  /** Ordered list of manifest ids forming the reading order. */
  spine: string[];
  /** If present, the spine element gets toc="ncxId" for Kindle periodical nav. */
  ncxId?: string;
  /** If present, a <guide> element is added for Kindle periodical metadata. */
  guide?: OpfGuide;
}

/**
 * Build content.opf. Includes EPUB3 series metadata plus NCX spine reference
 * and guide element for Kindle periodical navigation when provided.
 */
export function buildOpf(input: OpfInput): string {
  const manifestXml = input.manifest
    .map(
      (m) =>
        `    <item id="${m.id}" href="${escapeHtml(m.href)}" media-type="${m.mediaType}"` +
        (m.properties ? ` properties="${m.properties}"` : '') +
        ` />`,
    )
    .join('\n');

  const spineAttrs = input.ncxId ? ` toc="${escapeHtml(input.ncxId)}"` : '';
  const spineXml = input.spine.map((id) => `    <itemref idref="${id}" />`).join('\n');

  const guideXml = input.guide
    ? `  <guide>
    <reference type="masthead" href="${escapeHtml(input.guide.mastheadHref)}" title="Masthead"/>
    <reference type="toc" href="${escapeHtml(input.guide.tocHref)}" title="Table of Contents"/>
    <reference type="start" href="${escapeHtml(input.guide.startHref)}" title="Start"/>
  </guide>`
    : '';

  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">${escapeHtml(input.identifier)}</dc:identifier>
    <dc:title>${escapeHtml(input.title)}</dc:title>
    <dc:language>${escapeHtml(input.language)}</dc:language>
    <dc:creator>${escapeHtml(input.author)}</dc:creator>
    <dc:date>${escapeHtml(input.date)}</dc:date>
    <dc:type>magazine</dc:type>
    <meta property="dcterms:modified">${escapeHtml(input.modified)}</meta>
    <meta property="belongs-to-collection" id="series-id">${escapeHtml(input.series.name)}</meta>
    <meta refines="#series-id" property="collection-type">series</meta>
    <meta refines="#series-id" property="group-position">${escapeHtml(input.series.index)}</meta>
    <meta name="calibre:series" content="${escapeHtml(input.series.name)}" />
    <meta name="calibre:series_index" content="${escapeHtml(input.series.index)}" />
  </metadata>
  <manifest>
${manifestXml}
  </manifest>
  <spine${spineAttrs}>
${spineXml}
  </spine>
${guideXml}
</package>`;
}

export const CONTAINER_XML = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" />
  </rootfiles>
</container>`;

export interface NavEntry {
  href: string;
  label: string;
}

export function buildNav(title: string, entries: NavEntry[]): string {
  const lis = entries
    .map((e) => `      <li><a href="${escapeHtml(e.href)}">${escapeHtml(e.label)}</a></li>`)
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head><meta charset="utf-8" /><title>${escapeHtml(title)}</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>
${lis}
    </ol>
  </nav>
</body>
</html>`;
}
