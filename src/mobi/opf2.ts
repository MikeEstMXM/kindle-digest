import { escapeHtml } from '../util/html.js';

/**
 * Turn the app's EPUB 3 content.opf into the OPF 2 variant calibre needs to
 * emit a Kindle *periodical* (see docs/decisions.md for why each edit exists):
 *
 *  1. `version="2.0"` — calibre ignores the publication type on OPF 3.
 *  2. `calibre:publication_type` — makes the MOBI a periodical (EXTH 501 NWPR).
 *  3. `<meta name="cover">` — OPF 2 cover reference; EPUB 3's
 *     `properties="cover-image"` is ignored and the cover is lost.
 *
 * Pure string work, no I/O. Throws if the OPF is not shaped as expected, so a
 * writer change that breaks the recipe fails loudly instead of publishing a
 * coverless plain book.
 */
export function toPeriodicalOpf(opf: string, folder: string): string {
  const packageTag = /<package\b[^>]*>/.exec(opf);
  if (!packageTag || !/\sversion="[^"]*"/.test(packageTag[0])) {
    throw new Error('content.opf has no <package version="..."> element');
  }
  const coverId = findCoverImageId(opf);
  if (!coverId) throw new Error('content.opf has no manifest item with properties="cover-image"');
  if (!opf.includes('</metadata>')) throw new Error('content.opf has no </metadata>');

  const newPackageTag = packageTag[0].replace(/\sversion="[^"]*"/, ' version="2.0"');
  const metas =
    `    <meta name="calibre:publication_type" content="periodical:magazine:${escapeHtml(folder)}"/>\n` +
    `    <meta name="cover" content="${escapeHtml(coverId)}"/>\n`;

  return opf
    .replace(packageTag[0], () => newPackageTag)
    .replace('</metadata>', () => `${metas}  </metadata>`);
}

/** id of the manifest <item> flagged as the EPUB 3 cover image, if any. */
function findCoverImageId(opf: string): string | undefined {
  for (const tag of opf.match(/<item\b[^>]*>/g) ?? []) {
    const props = /\sproperties="([^"]*)"/.exec(tag)?.[1] ?? '';
    if (!props.split(/\s+/).includes('cover-image')) continue;
    const id = /\sid="([^"]+)"/.exec(tag)?.[1];
    if (id) return id;
  }
  return undefined;
}
