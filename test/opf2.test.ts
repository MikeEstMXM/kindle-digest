import { describe, it, expect } from 'vitest';
import { buildOpf } from '../src/epub/opf.js';
import { toPeriodicalOpf } from '../src/mobi/opf2.js';

/** The OPF the app really writes, so this breaks if the writer drifts from the recipe. */
function realOpf(): string {
  return buildOpf({
    identifier: 'urn:kindle-digest:News:2026-11-10',
    title: 'News',
    language: 'en',
    author: 'Kindle Digest',
    date: '2026-11-10',
    modified: '2026-11-10T06:30:00Z',
    manifest: [
      { id: 'nav', href: 'nav.xhtml', mediaType: 'application/xhtml+xml', properties: 'nav' },
      { id: 'art-1', href: 'art-1.xhtml', mediaType: 'application/xhtml+xml' },
      { id: 'img-0', href: 'images/cover.jpg', mediaType: 'image/jpeg', properties: 'cover-image' },
      { id: 'img-1', href: 'images/qr-1.png', mediaType: 'image/png' },
    ],
    spine: ['art-1'],
    ncxId: 'ncx',
    series: { name: 'News', index: '2026-11-10' },
  });
}

describe('toPeriodicalOpf', () => {
  it('downgrades the package to OPF 2.0', () => {
    const out = toPeriodicalOpf(realOpf(), 'News');
    expect(out).toMatch(/<package [^>]*version="2\.0"/);
    expect(out).not.toContain('version="3.0"');
    // The rest of the package tag is untouched.
    expect(out).toContain('unique-identifier="pub-id"');
  });

  it('adds the calibre periodical type with the folder name', () => {
    const out = toPeriodicalOpf(realOpf(), 'News');
    expect(out).toContain(
      '<meta name="calibre:publication_type" content="periodical:magazine:News"/>',
    );
  });

  it('points the OPF 2 cover meta at the cover-image manifest item', () => {
    const out = toPeriodicalOpf(realOpf(), 'News');
    expect(out).toContain('<meta name="cover" content="img-0"/>');
    // …and not at some other image.
    expect(out).not.toContain('content="img-1"');
  });

  it('puts both metas inside <metadata>', () => {
    const out = toPeriodicalOpf(realOpf(), 'News');
    const meta = out.slice(out.indexOf('<metadata'), out.indexOf('</metadata>'));
    expect(meta).toContain('calibre:publication_type');
    expect(meta).toContain('name="cover"');
  });

  it('keeps everything else: NCX spine, series, manifest, dc:type', () => {
    const before = realOpf();
    const out = toPeriodicalOpf(before, 'News');
    expect(out).toContain('<spine toc="ncx">');
    expect(out).toContain('calibre:series');
    expect(out).toContain('<dc:type>magazine</dc:type>');
    expect(out).toContain('properties="cover-image"');
    expect(out.match(/<item /g)?.length).toBe(before.match(/<item /g)?.length);
  });

  it('escapes odd folder names', () => {
    const out = toPeriodicalOpf(realOpf(), 'Tom & "Jerry" <Daily>');
    expect(out).toContain('periodical:magazine:Tom &amp; &quot;Jerry&quot; &lt;Daily&gt;');
  });

  it('fails loudly when there is no cover-image, rather than publishing a coverless issue', () => {
    const noCover = realOpf().replace(' properties="cover-image"', '');
    expect(() => toPeriodicalOpf(noCover, 'News')).toThrow(/cover-image/);
  });

  it('fails loudly on something that is not an OPF', () => {
    expect(() => toPeriodicalOpf('<html/>', 'News')).toThrow();
  });
});
