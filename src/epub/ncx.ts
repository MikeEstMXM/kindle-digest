import { escapeHtml } from '../util/html.js';

export interface NcxSection {
  feedTitle: string;
  sectionFilename: string;
  articles: { id: string; filename: string; title: string }[];
}

/** Build a Kindle-compatible NCX 2.0 document with three-level periodical hierarchy. */
export function buildNcx(folderName: string, sections: NcxSection[]): string {
  let po = 2; // periodical navPoint is 1

  const sectionNavPoints = sections
    .map((s, si) => {
      const secPo = po++;
      const articleNavPoints = s.articles
        .map((a) => {
          const artPo = po++;
          return `      <navPoint id="${escapeHtml(a.id)}" class="article" playOrder="${artPo}">
        <navLabel><text>${escapeHtml(a.title)}</text></navLabel>
        <content src="${escapeHtml(a.filename)}"/>
      </navPoint>`;
        })
        .join('\n');
      return `    <navPoint id="section-${si}" class="section" playOrder="${secPo}">
      <navLabel><text>${escapeHtml(s.feedTitle)}</text></navLabel>
      <content src="${escapeHtml(s.sectionFilename)}"/>
${articleNavPoints}
    </navPoint>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:kindle-digest:${escapeHtml(folderName)}"/>
    <meta name="dtb:depth" content="3"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${escapeHtml(folderName)}</text></docTitle>
  <navMap>
    <navPoint id="periodical" class="periodical" playOrder="1">
      <navLabel><text>${escapeHtml(folderName)}</text></navLabel>
      <content src="toc.xhtml"/>
${sectionNavPoints}
    </navPoint>
  </navMap>
</ncx>`;
}
