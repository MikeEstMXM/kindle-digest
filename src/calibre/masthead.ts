import sharp from 'sharp';
import { escapeHtml } from '../util/html.js';

/** Generate a 600×90 masthead JPEG: folder name in white on dark background.
 *  Stable across editions — no date — so all issues share the same masthead tile. */
export async function buildMastheadJpeg(folderName: string): Promise<Buffer> {
  const W = 600;
  const H = 90;
  const fontSize = 28;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#1a1a1a"/>
  <text x="${W / 2}" y="${Math.round(H * 0.68)}"
    font-family="'Liberation Sans',Arial,Helvetica,sans-serif"
    font-size="${fontSize}" font-weight="bold"
    fill="white" text-anchor="middle" letter-spacing="3">
    ${escapeHtml(folderName.toUpperCase())}
  </text>
</svg>`;
  return sharp({
    create: { width: W, height: H, channels: 3, background: { r: 26, g: 26, b: 26 } },
  })
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 90 })
    .toBuffer();
}
