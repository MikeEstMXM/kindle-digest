import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { processCoverImage, findCoverImageUrl } from '../src/content/images.js';

async function makeColorImage(): Promise<Buffer> {
  return sharp({
    create: { width: 1600, height: 1200, channels: 3, background: { r: 200, g: 40, b: 90 } },
  })
    .png()
    .toBuffer();
}

describe('processCoverImage', () => {
  it('produces grayscale JPEG within 1200x900 bounds', async () => {
    const out = await processCoverImage(await makeColorImage(), {
      contrast: 1.1,
      brightness: 0.72,
    });
    expect(out.width).toBeLessThanOrEqual(1200);
    expect(out.height).toBeLessThanOrEqual(900);

    // Sample pixels: grayscale means R == G == B.
    const { data } = await sharp(out.jpeg).raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < 30; i++) {
      const p = i * 3;
      expect(Math.abs(data[p] - data[p + 1])).toBeLessThanOrEqual(2);
      expect(Math.abs(data[p + 1] - data[p + 2])).toBeLessThanOrEqual(2);
    }
  });
});

describe('findCoverImageUrl', () => {
  it('prefers og:image from the page over body images', () => {
    const url = findCoverImageUrl(
      '<p><img src="https://body/img.jpg" /></p>',
      '<meta property="og:image" content="https://og/cover.jpg" />',
    );
    expect(url).toBe('https://og/cover.jpg');
  });

  it('falls back to the first body image', () => {
    const url = findCoverImageUrl('<p>hi</p><img src="https://body/first.png" />');
    expect(url).toBe('https://body/first.png');
  });

  it('returns undefined when no image exists', () => {
    expect(findCoverImageUrl('<p>no images here</p>')).toBeUndefined();
  });
});
