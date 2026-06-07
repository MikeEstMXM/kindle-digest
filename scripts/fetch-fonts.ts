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
}
interface GwfhFont {
  variants: GwfhVariant[];
}

async function downloadFont(family: string, variantId: string, outFile: string): Promise<void> {
  const metaRes = await fetch(`${GWFH}/${family}?subsets=latin`);
  if (!metaRes.ok) throw new Error(`gwfh metadata failed for ${family}: ${metaRes.status}`);
  const meta = (await metaRes.json()) as GwfhFont;
  const variant = meta.variants.find((v) => v.id === variantId);
  if (!variant?.woff2) {
    throw new Error(
      `Variant ${variantId} not found for ${family}. Available: ${meta.variants.map((v) => v.id).join(', ')}`,
    );
  }
  const fontRes = await fetch(variant.woff2);
  if (!fontRes.ok) throw new Error(`Font download failed for ${family} ${variantId}: ${fontRes.status}`);
  writeFileSync(outFile, Buffer.from(await fontRes.arrayBuffer()));
  console.log(`  ✓ ${outFile}`);
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Downloading ${FONT_FACES.length} fonts into ${OUT_DIR} ...`);
  for (const f of FONT_FACES) {
    const out = join(OUT_DIR, f.file);
    if (existsSync(out)) {
      console.log(`  • ${f.file} already present, skipping`);
      continue;
    }
    await downloadFont(f.gwfhFamily, f.gwfhVariant, out);
  }
  console.log('Done. Fonts are embedded into each EPUB from assets/fonts/.');
}

main().catch((err) => {
  console.error('Font download failed:', err);
  process.exit(1);
});
