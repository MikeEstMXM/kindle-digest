import { describe, it, expect } from 'vitest';
import {
  folderHash,
  templateIndex,
  glyphIndex,
  templateFor,
  glyphFor,
  GLYPHS,
  TEMPLATES,
} from '../src/cover/hash.js';

/** Reference implementation straight from the spec, to cross-check the code. */
function refHash(name: string): number {
  let h = 5381;
  for (const c of name) {
    h = ((h * 33) ^ c.codePointAt(0)!) & 0xffffffff;
  }
  return Math.abs(h >>> 0);
}

describe('cover hash assignment', () => {
  const samples = ['Technology', 'World News', 'Science', 'Business', 'a', '', 'Açaí ☕'];

  it('matches the spec reference hash and derived indices', () => {
    for (const name of samples) {
      const expected = refHash(name);
      expect(folderHash(name)).toBe(expected);
      expect(templateIndex(name)).toBe(expected % 4);
      expect(glyphIndex(name)).toBe(expected % 8);
    }
  });

  it('maps to valid templates and glyphs', () => {
    for (const name of samples) {
      expect(TEMPLATES).toContain(templateFor(name));
      expect(GLYPHS).toContain(glyphFor(name));
    }
  });

  it('is stable across calls (never changes day-to-day)', () => {
    expect(templateFor('Technology')).toBe(templateFor('Technology'));
    expect(glyphFor('Technology')).toBe(glyphFor('Technology'));
  });

  it('uses the exact glyph set in order', () => {
    expect(GLYPHS).toEqual(['◆', '●', '▲', '■', '◉', '✦', '※', '✶']);
  });
});
