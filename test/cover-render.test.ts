import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { renderCover } from '../src/cover/render.js';
import { buildCoverSvg, buildCoverJpeg } from '../src/cover/composite.js';
import { TEMPLATES, templateFor, glyphFor, type TemplateId } from '../src/cover/hash.js';
import { TEMPLATE_FONTS } from '../src/cover/fonts.js';

function sampleInput(folder: string) {
  return {
    folder,
    weekday: 'Saturday',
    isoDate: '2026-06-07',
    dateLabel: 'June 7, 2026',
    feeds: [
      { name: 'Ars Technica', count: 4 },
      { name: 'The Verge', count: 2 },
    ],
  };
}

function svgFor(folder: string, templateId: TemplateId, theme: 'light' | 'dark' = 'dark') {
  return buildCoverSvg(templateId, { ...sampleInput(folder), glyph: glyphFor(folder) }, theme);
}

/** Find one folder name that hashes to each template, for full coverage. */
function folderForTemplate(idx: number): string {
  for (let i = 0; i < 5000; i++) {
    const name = `folder-${i}`;
    if (TEMPLATES.indexOf(templateFor(name)) === idx) return name;
  }
  throw new Error(`no folder found for template ${idx}`);
}

describe('cover XHTML (render.ts)', () => {
  it('displays the pre-composited cover image full-bleed', () => {
    const { xhtml } = renderCover(sampleInput('Technology'));
    expect(xhtml).toContain('src="images/cover.jpg"');
  });

  it('alt text uses folder + date, not the weekday', () => {
    const { xhtml } = renderCover(sampleInput('Technology'));
    expect(xhtml).toContain('alt="Technology — June 7, 2026"');
  });

  it('uses the stable template/glyph for the folder', () => {
    const { templateId, glyph } = renderCover(sampleInput('Technology'));
    expect(templateId).toBe(templateFor('Technology'));
    expect(glyph).toBe(glyphFor('Technology'));
  });
});

describe('cover SVG (composite.ts)', () => {
  it('carries no @font-face and no external font URL', () => {
    // librsvg resolves families through fontconfig and ignores @font-face
    // webfonts, so an embedded base64 face is inert weight (5-22 KB per cover)
    // that also reads as though fonts were handled when they were not.
    // Fonts reach the renderer via src/cover/fontconfig.ts instead.
    for (const id of TEMPLATES) {
      const svg = svgFor(folderForTemplate(TEMPLATES.indexOf(id)), id);
      expect(svg).not.toContain('@font-face');
      expect(svg).not.toContain('data:font/woff2;base64,');
      expect(svg).not.toMatch(/https?:\/\/fonts\.g/i);
    }
  });

  it('renders the correct template font family for each template', () => {
    for (const id of TEMPLATES) {
      const svg = svgFor(folderForTemplate(TEMPLATES.indexOf(id)), id);
      expect(svg).toContain(`font-family="'${TEMPLATE_FONTS[id]}'`);
    }
  });

  it('the folder name is the headline; the date label is the subtitle; weekday is not drawn', () => {
    const svg = svgFor('World News', 'broadsheet');
    expect(svg).toContain('>World News<');
    expect(svg).toContain('>June 7, 2026<');
    expect(svg).not.toContain('>Saturday<');
  });

  it('broadsheet title sits at the masthead position with the rule/hairline pair', () => {
    const svg = svgFor('World News', 'broadsheet');
    expect(svg).toContain('x="64" y="250"');
    expect(svg).toContain('x="64" y="352"');
    expect(svg).toContain('<rect x="64" y="398" width="944" height="3"');
    expect(svg).toContain('<rect x="64" y="406" width="944" height="1"');
  });

  it('the-drop uppercases the title/date and applies the stroke halo', () => {
    const svg = svgFor('Culture', 'the-drop');
    expect(svg).toContain('>CULTURE<');
    expect(svg).toContain('>JUNE 7, 2026<');
    expect(svg).toContain('paint-order="stroke"');
  });

  it('the-review keeps the double border decoration, centred title, and rule pair', () => {
    const svg = svgFor('Longreads', 'the-review');
    expect(svg).toContain('<rect x="16" y="16" width="1040" height="1416"');
    expect(svg).toContain('<rect x="27" y="27" width="1018" height="1394"');
    expect(svg).toContain('text-anchor="middle">Longreads<');
    expect(svg).toContain('x1="375" y1="452" x2="697" y2="452"');
    expect(svg).toContain('x1="375" y1="738" x2="697" y2="738"');
  });

  it('the-signal draws a one-line chyron at the short-title plate height', () => {
    const svg = svgFor('Tech', 'the-signal');
    expect(svg).toContain('>TECH<');
    // 1 line: plateH = 390 - (2-1)*138 = 252, plate 618..870, rules at 614/870.
    expect(svg).toContain('<rect x="0" y="614" width="1072" height="4"');
    expect(svg).toContain('<rect x="0" y="618" width="1072" height="252" fill');
    expect(svg).toContain('<rect x="0" y="870" width="1072" height="4"');
  });

  it('the-signal wraps a too-wide title to two lines and grows the chyron to match', () => {
    const svg = svgFor('Tech & Startups', 'the-signal');
    expect(svg).toContain('>TECH &amp;<');
    expect(svg).toContain('>STARTUPS<');
    // 2 lines: plateH = 390, plate 618..1008, rules at 614/1008 (the spec's own numbers).
    expect(svg).toContain('<rect x="0" y="618" width="1072" height="390" fill');
    expect(svg).toContain('<rect x="0" y="1008" width="1072" height="4"');
  });

  it('shrinks an overlong title rather than letting it overflow', () => {
    const short = svgFor('News', 'broadsheet');
    const long = svgFor('An Extremely Long Folder Name For Testing Overflow', 'broadsheet');
    const shortSize = Number(short.match(/y="250" font-family="[^"]*" font-size="(\d+)"/)?.[1]);
    const longSize = Number(long.match(/y="250" font-family="[^"]*" font-size="(\d+)"/)?.[1]);
    expect(shortSize).toBe(140);
    expect(longSize).toBeLessThan(shortSize);
  });

  it('caps the feed list at 8 with an "…and N more" row', () => {
    const input = {
      ...sampleInput('Technology'),
      feeds: Array.from({ length: 11 }, (_, i) => ({ name: `Feed ${i}`, count: i })),
    };
    const svg = buildCoverSvg('broadsheet', { ...input, glyph: glyphFor('Technology') }, 'dark');
    expect(svg).toContain('…and 3 more');
    expect(svg).not.toContain('Feed 8<');
  });

  it('applies the light-theme palette without leaving any dark-theme literals behind', () => {
    const svg = svgFor('World News', 'broadsheet', 'light');
    expect(svg).toContain('#1a1a1a');
    expect(svg).not.toContain('fill="white"');
  });
});

/**
 * Everything above asserts on the SVG string. These two rasterize, because the
 * cover that reaches the Kindle is a JPEG and the SVG is only an intermediate:
 * a change that renders valid markup but a wrong-sized or colour-tinted image
 * would pass every test above.
 */
describe('buildCoverJpeg', () => {
  it('produces a JPEG at exactly 1072x1448, with and without a background image', async () => {
    const bg = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 90, g: 140, b: 200 } },
    })
      .jpeg()
      .toBuffer();

    for (const backgroundRaw of [bg, undefined]) {
      for (const theme of ['dark', 'light'] as const) {
        const jpeg = await buildCoverJpeg(sampleInput('Technology'), backgroundRaw, null, theme);
        const meta = await sharp(jpeg).metadata();
        expect(meta.format).toBe('jpeg');
        expect(meta.width).toBe(1072);
        expect(meta.height).toBe(1448);
      }
    }
  });

  it('stays grayscale even when the source image is strongly coloured', async () => {
    const bg = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 40, b: 90 } },
    })
      .jpeg()
      .toBuffer();

    const jpeg = await buildCoverJpeg(sampleInput('Technology'), bg, null, 'dark');
    // This strip sits over the background photo, not over an opaque overlay —
    // verified by rendering two differently coloured sources and confirming the
    // sampled luminance moves (67 vs 138). Were it overlay, the assertion below
    // would pass no matter what and prove nothing.
    const { data } = await sharp(jpeg)
      .extract({ left: 20, top: 400, width: 40, height: 10 })
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Grayscale means the three channels agree; a colour cast shows up as a
    // gap between them. Tolerance of 4 absorbs JPEG chroma subsampling.
    for (let i = 0; i < data.length / 3; i++) {
      const p = i * 3;
      expect(Math.abs(data[p] - data[p + 1])).toBeLessThanOrEqual(4);
      expect(Math.abs(data[p + 1] - data[p + 2])).toBeLessThanOrEqual(4);
    }
  });
});
