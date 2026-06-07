import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { FONT_FACES } from './fonts.js';

export interface LoadedFont {
  file: string;
  data: Buffer;
}

/**
 * Load all embedded woff2 fonts from the assets directory. Throws a clear
 * actionable error if any are missing (run `npm run fetch-fonts`).
 */
export function loadFontBuffers(fontsDir: string): LoadedFont[] {
  return FONT_FACES.map((f) => {
    const path = join(fontsDir, f.file);
    if (!existsSync(path)) {
      throw new Error(
        `Missing embedded font: ${f.file}. Run \`npm run fetch-fonts\` to download fonts into ${fontsDir}.`,
      );
    }
    return { file: f.file, data: readFileSync(path) };
  });
}
