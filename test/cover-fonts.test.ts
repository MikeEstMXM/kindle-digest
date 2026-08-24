/**
 * The cover's font handling, asserted against the *raster* rather than the SVG
 * string.
 *
 * This file exists because the string-level tests could not see the bug it
 * guards. The cover embedded every face as a base64 `@font-face`, and the SVG
 * duly contained one — but librsvg ignores `@font-face` webfonts entirely and
 * resolves through fontconfig, so covers rendered in a fallback face for
 * months while the suite stayed green. Worse, the fitting maths was calibrated
 * against the fonts that never rendered, so titles were sized with one font's
 * metrics and drawn in another's; The Signal's overflowed the page.
 *
 * Both tests below fail against that code and pass against the fix.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import sharp from 'sharp';
// Side-effect import: must run before the first text render or fontconfig
// caches a configuration that cannot see assets/fonts.
import '../src/cover/fontconfig.js';
import { buildCoverSvg, TITLE_BUDGET } from '../src/cover/composite.js';
import { glyphFor, type TemplateId } from '../src/cover/hash.js';
import { FONT_FACES } from '../src/cover/fonts.js';

/** Ink width of a string rendered through the same stack that draws covers. */
async function inkWidth(svgText: string): Promise<number> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="600">
<rect width="4000" height="600" fill="#fff"/>${svgText}</svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  const { info } = await sharp(png).trim({ threshold: 10 }).toBuffer({ resolveWithObject: true });
  return info.width;
}

function textEl(family: string, weight: number, style: string, size: number, text: string): string {
  return `<text x="20" y="400" font-family="${family}" font-weight="${weight}" font-style="${style}" font-size="${size}" fill="#000">${text}</text>`;
}

describe('cover fonts reach the renderer', () => {
  // A family fontconfig cannot resolve falls back to a default face. If a real
  // family renders at exactly the fallback's width, it was not found either.
  let fallbackWidth = 0;
  beforeAll(async () => {
    fallbackWidth = await inkWidth(
      textEl('NoSuchFamilyShouldExist', 400, 'normal', 150, 'TECHNOLOGY'),
    );
  });

  const families = [...new Set(FONT_FACES.map((f) => f.family))];

  it.each(families)('resolves %s instead of falling back', async (family) => {
    const face = FONT_FACES.find((f) => f.family === family)!;
    const width = await inkWidth(textEl(`'${family}'`, face.weight, face.style, 150, 'TECHNOLOGY'));
    expect(width).toBeGreaterThan(0);
    expect(width).not.toBe(fallbackWidth);
  });
});

/**
 * Pull the title `<text>` elements back out of the generated SVG and re-render
 * them standalone, so the assertion is against what librsvg actually draws at
 * the size the fitting logic chose — not against the fitting logic's own
 * arithmetic, which is what previously agreed with itself while being wrong.
 */
function titleElements(svg: string, title: string): string[] {
  const escaped = title.replace(/&/g, '&amp;');
  const words = escaped.split(' ');
  return [...svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)]
    .filter((m) => m[1] === escaped || (words.length > 1 && words.includes(m[1])))
    .map((m) => m[0]);
}

describe('title fits the cover width', () => {
  // Short names are the realistic case and the long ones are boundary guards.
  // Both matter: "TECHNOLOGY" in The Signal rendered 977 px against a 944 px
  // budget under the old estimate — the clipped cover that prompted this work —
  // while a 7-letter name like "Culture" was drawn at 182 px in The Drop when
  // it had room for the full 230 px.
  const CASES: Array<[TemplateId, string]> = [
    ['the-signal', 'Tech'],
    ['the-signal', 'Design'],
    ['the-signal', 'Technology'],
    ['the-signal', 'Tech & Startups'],
    ['broadsheet', 'News'],
    ['broadsheet', 'An Extremely Long Folder Name'],
    ['the-drop', 'Culture'],
    ['the-drop', 'Technology'],
    ['the-review', 'Reading'],
    ['the-review', 'Longreads'],
  ];

  it.each(CASES)('%s / %s stays inside the title budget', async (templateId, folder) => {
    const svg = buildCoverSvg(
      templateId,
      {
        folder,
        weekday: 'Saturday',
        isoDate: '2026-06-07',
        dateLabel: 'June 7, 2026',
        feeds: [],
        glyph: glyphFor(folder),
      },
      'dark',
    );
    // The Drop and The Signal uppercase their titles.
    const drawn =
      templateId === 'the-drop' || templateId === 'the-signal' ? folder.toUpperCase() : folder;
    const els = titleElements(svg, drawn);
    expect(els.length).toBeGreaterThan(0);

    for (const el of els) {
      // Rendered standalone the element keeps its own font-size, family,
      // weight, style and letter-spacing, so this measures the real drawn line.
      // It is repositioned onto the measuring canvas first: cover titles are
      // white on a dark plate (nothing to trim against white), The Signal's
      // baseline sits below this canvas, and The Review anchors on its centre,
      // which would push half the glyphs off the left edge and pass vacuously.
      // The stroke halo goes too — decoration, not part of the text's width.
      const normalised = el
        .replace(/x="\d+"/, 'x="20"')
        .replace(/y="\d+"/, 'y="400"')
        .replace(/fill="[^"]*"/, 'fill="#000"')
        .replace(/\stext-anchor="[^"]*"/g, '')
        .replace(
          /\s(?:stroke|stroke-width|stroke-opacity|stroke-linejoin|paint-order)="[^"]*"/g,
          '',
        );
      const width = await inkWidth(normalised);
      // A zero-width or full-canvas result means nothing was drawn — the
      // measurement failed rather than the text fitting.
      expect(width).toBeGreaterThan(0);
      expect(width).toBeLessThan(4000);
      expect(width).toBeLessThanOrEqual(TITLE_BUDGET);
    }
  });
});
