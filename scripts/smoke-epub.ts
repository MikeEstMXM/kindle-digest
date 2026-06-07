/**
 * End-to-end smoke: build a real EPUB through the orchestrator with mocked
 * network (no Inoreader/SMTP), embedding the downloaded fonts, then validate
 * the package structure. Writes out/sample.epub for manual inspection.
 *
 * Run: npx tsx scripts/smoke-epub.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import sharp from 'sharp';
import { buildFolderDigest } from '../src/digest/orchestrator.js';
import { loadFontBuffers } from '../src/cover/fontLoader.js';
import type { NormalizedArticle } from '../src/inoreader/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FONTS = join(__dirname, '..', 'assets', 'fonts');

const articles: NormalizedArticle[] = [
  {
    itemId: 'i1',
    title: 'The Long Read: How E-ink Works',
    url: 'https://example.com/eink',
    feedTitle: 'Ars Technica',
    author: 'Jane Doe',
    publishedMs: Date.parse('2026-06-06T12:00:00Z'),
    inoreaderHtml: `<p><img src="https://img.example.com/hero.jpg"/>${'<p>Full content paragraph that is clearly long enough to be treated as complete by the detector. </p>'.repeat(40)}`,
    inoreaderTextLength: 4000,
  },
  {
    itemId: 'i2',
    title: 'Short Item Needing Fallback',
    url: 'https://example.com/short',
    feedTitle: 'The Verge',
    inoreaderHtml: '<p>too short</p>',
    inoreaderTextLength: 8,
  },
];

async function main(): Promise<void> {
  const fonts = loadFontBuffers(FONTS);

  // Mock page fetch (Readability fallback target) and image fetch.
  const fetchPage = async (url: string) => ({
    status: 200,
    body: `<html><head><title>Recovered</title></head><body><article><h1>Recovered</h1>${'<p>This is the recovered full text from the source page, extracted by Readability for the fallback path. </p>'.repeat(10)}</article></body></html>`.replace('SRC', url),
  });
  const sampleImage = await sharp({
    create: { width: 1400, height: 1000, channels: 3, background: { r: 120, g: 80, b: 60 } },
  })
    .jpeg()
    .toBuffer();
  const fetchImage = (async () =>
    new Response(new Uint8Array(sampleImage), { status: 200 })) as unknown as typeof fetch;

  const built = await buildFolderDigest('Technology', articles, 3, {
    isoDate: '2026-06-07',
    timezone: 'America/New_York',
    author: 'Smoke Test',
    minChars: 1800,
    fonts,
    fetchPage,
    fetchImage,
  });

  const outDir = join(__dirname, '..', 'out');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'sample.epub');
  writeFileSync(outPath, built.epub);

  // Validate structure.
  const zip = await JSZip.loadAsync(built.epub);
  const opf = await zip.file('OEBPS/content.opf')!.async('string');
  const cover = await zip.file('OEBPS/cover.xhtml')!.async('string');
  const diag = await zip.file('OEBPS/diagnostics.xhtml')!.async('string');

  const checks: [string, boolean][] = [
    ['mimetype present', !!zip.file('mimetype')],
    ['cover.xhtml present', !!zip.file('OEBPS/cover.xhtml')],
    ['cover image embedded', !!zip.file('OEBPS/images/cover.jpg')],
    ['fonts embedded', !!zip.file('OEBPS/fonts/PlayfairDisplay-900.woff2')],
    ['qr embedded', !!zip.file('OEBPS/images/qr-1.png')],
    ['series name=folder', opf.includes('>Technology</meta>')],
    ['series index=ISO date', opf.includes('group-position">2026-06-07')],
    ['spine cover first', opf.indexOf('cover-page') < opf.indexOf('art-1')],
    ['diagnostics last', opf.indexOf('art-2') < opf.indexOf('"diagnostics"')],
    ['cover references font', cover.includes("url('fonts/")],
    ['diag shows Inoreader source', diag.includes('Inoreader API')],
    ['diag shows Readability fallback', diag.includes('Readability.js fallback')],
  ];

  let ok = true;
  for (const [name, pass] of checks) {
    console.log(`${pass ? '✓' : '✗'} ${name}`);
    if (!pass) ok = false;
  }
  console.log(`\nWrote ${outPath} (${(built.epub.length / 1024).toFixed(1)} KB)`);
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
