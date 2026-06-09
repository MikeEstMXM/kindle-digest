import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { buildEpub, buildManifestAndSpine, type EpubInput } from '../src/epub/writer.js';

function sampleInput(): EpubInput {
  return {
    identifier: 'urn:kindle-digest:Technology:2026-06-07',
    title: 'Technology',
    author: 'Kindle Digest',
    date: '2026-06-07',
    coverXhtml: '<?xml version="1.0"?><html><body>cover</body></html>',
    tocXhtml: '<?xml version="1.0"?><html><body>toc</body></html>',
    articles: [
      { id: 'art-1', filename: 'art-1.xhtml', title: 'First', xhtml: '<html><body>1</body></html>' },
      { id: 'art-2', filename: 'art-2.xhtml', title: 'Second', xhtml: '<html><body>2</body></html>' },
    ],
    diagnosticsXhtml: '<html><body>diag</body></html>',
    fonts: [{ file: 'Oswald-700.woff2', data: Buffer.from('FONT') }],
    images: [
      { href: 'images/cover.jpg', data: Buffer.from('IMG'), mediaType: 'image/jpeg', isCover: true },
      { href: 'images/qr-1.png', data: Buffer.from('QR'), mediaType: 'image/png' },
    ],
  };
}

describe('buildManifestAndSpine', () => {
  it('orders spine: cover → toc → articles → diagnostics', () => {
    const { spine } = buildManifestAndSpine(sampleInput());
    expect(spine).toEqual(['cover-page', 'toc', 'art-1', 'art-2', 'diagnostics']);
  });

  it('marks the cover image with cover-image property', () => {
    const { manifest } = buildManifestAndSpine(sampleInput());
    const cover = manifest.find((m) => m.href === 'images/cover.jpg');
    expect(cover?.properties).toBe('cover-image');
    expect(manifest.find((m) => m.id === 'nav')?.properties).toBe('nav');
  });
});

describe('buildEpub', () => {
  it('produces a valid zip with mimetype stored first', async () => {
    const buf = await buildEpub(sampleInput());
    // EPUB OCF: bytes 30.. must be the mimetype string (stored, uncompressed).
    const head = buf.subarray(0, 60).toString('latin1');
    expect(head).toContain('mimetype');
    expect(head).toContain('application/epub+zip');
  });

  it('sets dc:type=magazine and bare publication title (no date in title)', async () => {
    const buf = await buildEpub(sampleInput());
    const zip = await JSZip.loadAsync(buf);
    const opf = await zip.file('OEBPS/content.opf')!.async('string');

    expect(opf).toContain('<dc:type>magazine</dc:type>');
    expect(opf).toContain('<dc:title>Technology</dc:title>');
    expect(opf).not.toContain('belongs-to-collection');
    expect(opf).not.toContain('calibre:series');
  });

  it('includes all expected files and an itemref spine in order', async () => {
    const zip = await JSZip.loadAsync(await buildEpub(sampleInput()));
    expect(zip.file('mimetype')).toBeTruthy();
    expect(zip.file('META-INF/container.xml')).toBeTruthy();
    expect(zip.file('OEBPS/cover.xhtml')).toBeTruthy();
    expect(zip.file('OEBPS/toc.xhtml')).toBeTruthy();
    expect(zip.file('OEBPS/diagnostics.xhtml')).toBeTruthy();
    expect(zip.file('OEBPS/fonts/Oswald-700.woff2')).toBeTruthy();
    expect(zip.file('OEBPS/images/cover.jpg')).toBeTruthy();

    const opf = await zip.file('OEBPS/content.opf')!.async('string');
    const order = ['cover-page', 'toc', 'art-1', 'art-2', 'diagnostics'].map(
      (id) => opf.indexOf(`idref="${id}"`),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[0]).toBeGreaterThan(-1);
  });
});
