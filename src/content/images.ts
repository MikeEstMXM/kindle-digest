import sharp from 'sharp';

export interface ImageAdjust {
  /** Contrast multiplier, e.g. 1.1. Applied around mid-grey (128). */
  contrast: number;
  /** Brightness multiplier, e.g. 0.72 (darken) .. 1.0. */
  brightness: number;
}

export interface ProcessedImage {
  jpeg: Buffer;
  width: number;
  height: number;
}

/**
 * Find a usable cover image URL. Prefers an og:image on the source page,
 * then the first <img> in the article body. Returns undefined if none.
 */
export function findCoverImageUrl(articleHtml: string, pageHtml?: string): string | undefined {
  if (pageHtml) {
    const og =
      pageHtml.match(
        /<meta[^>]+property=["']og:image(?::url)?["'][^>]+content=["']([^"']+)["']/i,
      ) ||
      pageHtml.match(
        /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::url)?["']/i,
      );
    if (og?.[1]) return og[1];
  }
  const img = articleHtml.match(/<img[^>]+src=["']([^"']+)["']/i);
  return img?.[1];
}

/** Download an image to a Buffer. Throws on non-2xx. */
export async function downloadImage(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<Buffer> {
  const res = await fetchFn(url, {
    headers: { 'User-Agent': 'kindle-digest/1.0 (+image fetch)' },
  });
  if (!res.ok) throw new Error(`Image fetch failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Convert to grayscale (server-side, per spec — never CSS filters), apply
 * template-specific contrast/brightness, resize to fit max 1200×900, JPEG q70.
 */
export async function processCoverImage(
  input: Buffer,
  adjust: ImageAdjust,
): Promise<ProcessedImage> {
  // linear(a, b): out = a*in + b. For contrast around 128: b = 128 - 128*a.
  const a = adjust.contrast;
  const b = 128 - 128 * a;
  const pipeline = sharp(input)
    .grayscale()
    .linear(a, b)
    .modulate({ brightness: adjust.brightness })
    .resize({ width: 1600, height: 2400, fit: 'cover', position: 'centre' })
    .jpeg({ quality: 85 });
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return { jpeg: data, width: info.width, height: info.height };
}

/** Grayscale + downscale an in-article image for e-ink and small EPUB size. */
export async function processArticleImage(input: Buffer): Promise<ProcessedImage> {
  const { data, info } = await sharp(input)
    .grayscale()
    .resize({ width: 1000, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 72 })
    .toBuffer({ resolveWithObject: true });
  return { jpeg: data, width: info.width, height: info.height };
}
