import { execFile } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Run ebook-convert on a recipe directory produced by buildRecipeDir.
 * Returns the resulting EPUB as a Buffer. Always cleans up the temp dir.
 */
export async function buildCalibreEpub(recipeDir: string): Promise<Buffer> {
  const recipePath = join(recipeDir, 'digest.recipe');
  const outputPath = join(recipeDir, 'output.azw3');
  const coverPath = join(recipeDir, 'cover.jpg');

  try {
    const { stderr } = await execFileAsync(
      'ebook-convert',
      [
        recipePath,
        outputPath,
        '--output-profile', 'kindle',
        '--cover', coverPath,
      ],
      {
        env: { ...process.env, CALIBRE_NO_NATIVE_DISPLAY: '1' },
        timeout: 180_000,
      },
    );
    if (stderr) console.error('[calibre]', stderr);
    return readFileSync(outputPath);
  } finally {
    try {
      rmSync(recipeDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}
