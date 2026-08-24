/**
 * Real text measurement for the cover title, read from the font itself.
 *
 * This replaces a `characters × size × ratio` estimate. That estimate was
 * calibrated against fonts that never actually rendered (see fontconfig.ts),
 * so it was wrong in both directions once they did: it under-measured The
 * Signal's Bricolage by ~7% — enough for "TECHNOLOGY" to exceed the title
 * budget without any shrink firing, which is what clipped the cover — and
 * over-measured The Drop's condensed Bebas Neue by nearly 2×, shrinking those
 * titles to roughly half the size they could have been.
 *
 * Summing `hmtx` advances for the same face librsvg resolves lands within
 * ~1-5% *above* measured ink across all four templates. Erring high is the
 * safe direction for a fit budget: the text is never wider than we think.
 *
 * Metrics must come from the same family+weight+style that fontconfig will
 * select — measuring an upright while italic renders is a ~14% error, larger
 * than the bug this replaces.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import opentype from 'opentype.js';
import { FONT_FACES, type FontFace } from './fonts.js';
import { COVER_FONTS_DIR } from './fontconfig.js';

/** Measures a string's advance width in px at a given font size. */
export type TextMeasurer = (text: string, size: number) => number;

/**
 * Pick the registered face for a family/weight/style. Falls back to the
 * nearest weight within the family so a design tweak to a `font-weight`
 * attribute cannot silently start measuring a different family.
 */
export function selectFace(
  family: string,
  weight: number,
  style: 'normal' | 'italic',
): FontFace | undefined {
  const inFamily = FONT_FACES.filter((f) => f.family === family);
  if (inFamily.length === 0) return undefined;
  const styled = inFamily.filter((f) => f.style === style);
  const pool = styled.length > 0 ? styled : inFamily;
  return pool.reduce((best, f) =>
    Math.abs(f.weight - weight) < Math.abs(best.weight - weight) ? f : best,
  );
}

const cache = new Map<string, opentype.Font | null>();

function loadFont(ttfFile: string, fontsDir: string): opentype.Font | null {
  const key = join(fontsDir, ttfFile);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let font: opentype.Font | null = null;
  if (existsSync(key)) {
    try {
      const buf = readFileSync(key);
      font = opentype.parse(
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
      );
    } catch {
      // An unparseable font must not take the whole digest down; the caller
      // falls back to an estimate and the cover still builds.
      font = null;
    }
  }
  cache.set(key, font);
  return font;
}

/**
 * Conservative fallback used only when the font file is missing or unreadable
 * — tests that stub the font directory, or a botched deploy. Deliberately wide
 * so a title shrinks rather than clips when we cannot measure it.
 */
const FALLBACK_RATIO = 0.75;

/**
 * Build a measurer for one face. Never throws: if the font cannot be read it
 * returns a conservative estimate rather than failing the build.
 */
export function textMeasurer(
  family: string,
  weight: number,
  style: 'normal' | 'italic',
  fontsDir: string = COVER_FONTS_DIR,
): TextMeasurer {
  const face = selectFace(family, weight, style);
  const font = face ? loadFont(face.ttfFile, fontsDir) : null;
  if (!font) return (text, size) => text.length * size * FALLBACK_RATIO;
  return (text, size) => font.getAdvanceWidth(text, size);
}
