import sharp from 'sharp';
import { escapeHtml } from '../util/html.js';

/** Build a 600×60 masthead JPEG for Kindle periodical display. */
export async function buildMasthead(folderName: string): Promise<Buffer> {
  const W = 600;
  const H = 60;
  const label = folderName.length > 42 ? folderName.slice(0, 39) + '…' : folderName;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#1a1a1a"/>
  <text x="${W / 2}" y="39" font-family="Georgia, serif" font-size="26"
        fill="white" text-anchor="middle">${escapeHtml(label)}</text>
</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}
