import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { buildEpub } from '../../src/epub/writer.js';
import { buildNcx } from '../../src/epub/ncx.js';

/** A small but structurally real digest EPUB: periodical NCX, cover-image, 2 sections. */
export async function fixtureEpub(path: string, folder: string): Promise<void> {
  const cover = await sharp({
    create: { width: 300, height: 400, channels: 3, background: '#445566' },
  })
    .jpeg()
    .toBuffer();
  const page = (t: string): string =>
    `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${t}</title></head><body><h1>${t}</h1><p>${'Body text. '.repeat(40)}</p></body></html>`;
  const articles = [1, 2, 3, 4].map((n) => ({
    id: `art-${n}`,
    filename: `art-${n}.xhtml`,
    title: `Article ${n}`,
    xhtml: page(`Article ${n}`),
  }));
  const groups = [
    { feedTitle: 'Feed A', filename: 'feed-0-index.xhtml', ids: ['art-1', 'art-2'] },
    { feedTitle: 'Feed B', filename: 'feed-1-index.xhtml', ids: ['art-3', 'art-4'] },
  ];
  const buf = await buildEpub({
    identifier: `urn:kindle-digest:${folder}:2026-11-10`,
    title: folder,
    author: 'Kindle Digest',
    date: '2026-11-10',
    series: { name: folder, index: '2026-11-10' },
    coverXhtml: page('Cover'),
    tocXhtml: page('Contents'),
    articles,
    diagnosticsXhtml: page('Diagnostics'),
    fonts: [],
    images: [
      { href: 'images/cover.jpg', data: cover, mediaType: 'image/jpeg', isCover: true },
      { href: 'images/masthead.jpg', data: cover, mediaType: 'image/jpeg' },
    ],
    feedGroups: groups.map((g) => ({
      feedTitle: g.feedTitle,
      filename: g.filename,
      xhtml: page(g.feedTitle),
      articleIds: g.ids,
    })),
    ncxXml: buildNcx(
      folder,
      groups.map((g) => ({
        feedTitle: g.feedTitle,
        sectionFilename: g.filename,
        articles: g.ids.map((id) => {
          const a = articles.find((x) => x.id === id)!;
          return { id, filename: a.filename, title: a.title };
        }),
      })),
    ),
  });
  await writeFile(path, buf);
}
