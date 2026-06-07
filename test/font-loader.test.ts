import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadFontBuffers } from '../src/cover/fontLoader.js';
import { FONT_FACES } from '../src/cover/fonts.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fonts-'));
  for (const f of FONT_FACES) writeFileSync(join(dir, f.file), Buffer.from(`woff2:${f.file}`));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('loadFontBuffers', () => {
  it('loads every registered font face', () => {
    const loaded = loadFontBuffers(dir);
    expect(loaded.map((l) => l.file).sort()).toEqual(FONT_FACES.map((f) => f.file).sort());
    expect(loaded.every((l) => l.data.length > 0)).toBe(true);
  });

  it('throws an actionable error when a font is missing', () => {
    unlinkSync(join(dir, FONT_FACES[0].file));
    expect(() => loadFontBuffers(dir)).toThrow(/fetch-fonts/);
  });
});
