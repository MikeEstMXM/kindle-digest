/**
 * Download the cover fonts as woff2 into assets/fonts/. Uses the
 * google-webfonts-helper API (gwfh), which serves Google Fonts as static
 * woff2 files we can embed — keeping EPUBs self-contained (no CDN at runtime).
 *
 * Run: npm run fetch-fonts
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FONT_FACES } from '../src/cover/fonts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'assets', 'fonts');
const GWFH = 'https://gwfh.mranftl.com/api/fonts';

interface GwfhVariant {
  id: string;
  woff2: string;
  ttf: string;
}
interface GwfhFont {
  variants: GwfhVariant[];
}

async function fetchTo(url: string, outFile: string, label: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Font download failed for ${label}: ${res.status}`);
  writeFileSync(outFile, Buffer.from(await res.arrayBuffer()));
  console.log(`  ✓ ${outFile}`);
}

/**
 * Download both formats for one face. Both are needed and they are not
 * interchangeable: the woff2 is embedded in the EPUB, while the ttf is what
 * fontconfig indexes so librsvg can find the family when rasterizing the
 * cover — and it is the only one opentype.js can read metrics from.
 */
async function downloadFont(
  family: string,
  variantId: string,
  woff2Out: string,
  ttfOut: string,
): Promise<void> {
  const metaRes = await fetch(`${GWFH}/${family}?subsets=latin`);
  if (!metaRes.ok) throw new Error(`gwfh metadata failed for ${family}: ${metaRes.status}`);
  const meta = (await metaRes.json()) as GwfhFont;
  const variant = meta.variants.find((v) => v.id === variantId);
  if (!variant?.woff2 || !variant.ttf) {
    throw new Error(
      `Variant ${variantId} not found for ${family}. Available: ${meta.variants.map((v) => v.id).join(', ')}`,
    );
  }
  const label = `${family} ${variantId}`;
  if (!existsSync(woff2Out)) await fetchTo(variant.woff2, woff2Out, label);
  if (!existsSync(ttfOut)) await fetchTo(variant.ttf, ttfOut, label);
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Downloading ${FONT_FACES.length} fonts (woff2 + ttf) into ${OUT_DIR} ...`);
  for (const f of FONT_FACES) {
    const woff2Out = join(OUT_DIR, f.file);
    const ttfOut = join(OUT_DIR, f.ttfFile);
    if (existsSync(woff2Out) && existsSync(ttfOut)) {
      console.log(`  • ${f.file} + ${f.ttfFile} already present, skipping`);
      continue;
    }
    await downloadFont(f.gwfhFamily, f.gwfhVariant, woff2Out, ttfOut);
  }
  console.log('Done. Fonts are embedded into each EPUB from assets/fonts/.');
}

main().catch((err) => {
  console.error('Font download failed:', err);
  process.exit(1);
});
