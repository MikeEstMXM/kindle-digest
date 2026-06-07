import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import jsQR from 'jsqr';
import { generateQrPng, qrMinSize } from '../src/content/qr.js';

async function decodeQr(png: Buffer): Promise<{ data: string; width: number; height: number }> {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const result = jsQR(new Uint8ClampedArray(data), info.width, info.height);
  if (!result) throw new Error('QR did not decode');
  return { data: result.data, width: info.width, height: info.height };
}

describe('generateQrPng', () => {
  it('encodes the original URL and decodes back to it', async () => {
    const url = 'https://example.com/articles/the-full-story?id=42';
    const png = await generateQrPng(url, { size: 240 });
    const decoded = await decodeQr(png);
    expect(decoded.data).toBe(url);
  });

  it('enforces the 200x200 minimum for e-ink scannability', async () => {
    const png = await generateQrPng('https://example.com/x', { size: 50 });
    const decoded = await decodeQr(png);
    expect(decoded.width).toBeGreaterThanOrEqual(qrMinSize());
    expect(decoded.height).toBeGreaterThanOrEqual(qrMinSize());
  });
});
