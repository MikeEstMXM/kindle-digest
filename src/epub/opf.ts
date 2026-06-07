import { escapeHtml } from '../util/html.js';

export interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties?: string;
}

export interface OpfInput {
  identifier: string;
  title: string;
  language: string;
  author: string;
  /** ISO date string (also used as the series index). */
  date: string;
  modified: string; // ISO 8601 dcterms:modified
  series: { name: string; index: string };
  manifest: ManifestItem[];
  /** Ordered list of manifest ids forming the reading order. */
  spine: string[];
}

/**
 * Build content.opf. Series metadata is written two ways for maximum reader
 * compatibility: EPUB3 `belongs-to-collection` (series) and the legacy
 * calibre meta. Series name = folder; series index = ISO date string.
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

  const spineXml = input.spine.map((id) => `    <itemref idref="${id}" />`).join('\n');

  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">${escapeHtml(input.identifier)}</dc:identifier>
    <dc:title>${escapeHtml(input.title)}</dc:title>
    <dc:language>${escapeHtml(input.language)}</dc:language>
    <dc:creator>${escapeHtml(input.author)}</dc:creator>
    <dc:date>${escapeHtml(input.date)}</dc:date>
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
  <spine>
${spineXml}
  </spine>
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
