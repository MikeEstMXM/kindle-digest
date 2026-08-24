import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { buildCoverSvg, buildCoverJpeg } from '../src/cover/composite.js';
import { TEMPLATES, templateFor, glyphFor } from '../src/cover/hash.js';
import { loadFontBuffers } from '../src/cover/fontLoader.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = join(__dirname, '..', 'assets', 'fonts');
const FONTS = loadFontBuffers(FONTS_DIR);

const ISO_DATE = '2026-06-07';

function sampleInput(folder: string) {
  return {
    folder,
    weekday: 'Saturday',
    isoDate: ISO_DATE,
    dateLabel: 'June 7, 2026',
    feeds: [
      { name: 'Ars Technica', count: 4 },
      { name: 'The Verge', count: 2 },
    ],
  };
}

/** Find one folder name that hashes to each template, for full coverage. */
function folderForTemplate(idx: number): string {
  for (let i = 0; i < 5000; i++) {
    const name = `folder-${i}`;
    if (TEMPLATES.indexOf(templateFor(name)) === idx) return name;
  }
  throw new Error(`no folder found for template ${idx}`);
}

function svgFor(folder: string, theme: 'light' | 'dark' = 'dark'): string {
  const templateId = templateFor(folder);
  const input = { ...sampleInput(folder), glyph: glyphFor(folder) };
  return buildCoverSvg(templateId, input, FONTS, theme);
}

describe('cover rendering (SVG overlay)', () => {
  it('renders weekday and folder text for every template', () => {
    for (let i = 0; i < TEMPLATES.length; i++) {
      const folder = folderForTemplate(i);
      const svg = svgFor(folder);
      const wd = TEMPLATES[i] === 'the-drop' || TEMPLATES[i] === 'the-signal' ? 'SATURDAY' : 'Saturday';
      expect(svg).toContain(wd);
      expect(svg).toContain(`>${folder}<`);
    }
  });

  it('renders the date, paired with the weekday, for every template', () => {
    for (let i = 0; i < TEMPLATES.length; i++) {
      const templateId = TEMPLATES[i];
      const folder = folderForTemplate(i);
      const svg = svgFor(folder);

      const uppercase = templateId === 'the-drop' || templateId === 'the-signal';
      const expectedDate = uppercase ? 'JUN 07' : 'Jun 07';
      const expectedWeekday = uppercase ? 'SATURDAY' : 'Saturday';

      // Parse every <text> element (attrs + content) in source order. The
      // bottom zone is built bottom-up: folder, then date, then weekday last.
      const textEls = [...svg.matchAll(/<text([^>]*)>([^<]*)<\/text>/g)].map((m) => ({
        fontSize: Number(m[1].match(/font-size="(\d+)"/)?.[1]),
        content: m[2],
      }));
      const folderIdx = textEls.findIndex((t) => t.content === folder);
      const dateIdx = textEls.findIndex((t) => t.content === expectedDate);
      const weekdayIdx = textEls.findIndex((t) => t.content === expectedWeekday);

      expect(folderIdx).toBeGreaterThan(-1);
      expect(dateIdx).toBeGreaterThan(-1);
      expect(weekdayIdx).toBeGreaterThan(-1);
      // Never the long form.
      expect(svg).not.toContain('June 7, 2026');

      // Date sits directly between folder and weekday — a tight adjacent
      // pair with weekday, with folder immediately before it.
      expect(folderIdx).toBe(dateIdx - 1);
      expect(weekdayIdx).toBe(dateIdx + 1);

      // Date font-size is ~60% of the weekday font-size.
      const ratio = textEls[dateIdx].fontSize / textEls[weekdayIdx].fontSize;
      expect(ratio).toBeGreaterThan(0.55);
      expect(ratio).toBeLessThan(0.65);
    }
  });

  it('renders the feed list with names and counts', () => {
    // Broadsheet doesn't uppercase feed names, so mixed-case names round-trip
    // unmodified — pick a folder guaranteed to hash to it.
    const broadsheet = folderForTemplate(TEMPLATES.indexOf('broadsheet'));
    const svg = svgFor(broadsheet);
    expect(svg).toContain('Ars Technica');
    expect(svg).toContain('4');
    expect(svg).toContain('The Verge');
    expect(svg).toContain('2');
  });

  it('uses the stable hash-derived glyph', () => {
    const svg = svgFor('Technology');
    expect(svg).toContain(glyphFor('Technology'));
  });

  it('embeds fonts as base64 data URIs, no external CDN', () => {
    const svg = svgFor('Technology');
    expect(svg).toContain('@font-face');
    expect(svg).toMatch(/url\('data:font\/woff2;base64,[^']+'\)/);
    expect(svg).not.toMatch(/https?:\/\/fonts\.g/i);
    expect(svg).not.toContain('cdn');
  });

  it('The Review still gets its double-border decoration', () => {
    const review = folderForTemplate(TEMPLATES.indexOf('the-review'));
    const svg = svgFor(review);
    const borderRects = svg.match(/<rect[^>]+fill="none"[^>]*\/>/g) ?? [];
    expect(borderRects.length).toBe(2);
  });

  it('SVG canvas is the Kindle Paperwhite size (1072x1448)', () => {
    const svg = svgFor('Technology');
    expect(svg).toContain('width="1072"');
    expect(svg).toContain('height="1448"');
  });

  it('theme changes text color', () => {
    const dark = svgFor('Technology', 'dark');
    const light = svgFor('Technology', 'light');
    expect(dark).toContain('fill="white"');
    expect(light).toContain('fill="#1a1a1a"');
  });
});

describe('buildCoverJpeg', () => {
  it('produces a JPEG at exactly 1072x1448, with and without a background image', async () => {
    const bg = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 90, g: 140, b: 200 } },
    })
      .jpeg()
      .toBuffer();

    for (const backgroundRaw of [bg, undefined]) {
      for (const theme of ['dark', 'light'] as const) {
        const jpeg = await buildCoverJpeg(sampleInput('Technology'), backgroundRaw, FONTS, null, theme);
        const meta = await sharp(jpeg).metadata();
        expect(meta.format).toBe('jpeg');
        expect(meta.width).toBe(1072);
        expect(meta.height).toBe(1448);
      }
    }
  });

  it('stays visually grayscale even with a colorful background image', async () => {
    const bg = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 40, b: 90 } },
    })
      .jpeg()
      .toBuffer();

    const jpeg = await buildCoverJpeg(sampleInput('Technology'), bg, FONTS, null, 'dark');
    // Sample a strip away from any text/decoration (mid-left, above the gradient's
    // dark band) to check the underlying photo treatment stayed grayscale.
    const { data } = await sharp(jpeg)
      .extract({ left: 20, top: 400, width: 40, height: 10 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (let i = 0; i < data.length / 3; i++) {
      const p = i * 3;
      expect(Math.abs(data[p] - data[p + 1])).toBeLessThanOrEqual(4);
      expect(Math.abs(data[p + 1] - data[p + 2])).toBeLessThanOrEqual(4);
    }
  });
});
