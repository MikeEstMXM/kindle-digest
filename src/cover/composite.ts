import sharp from 'sharp';
import { escapeHtml } from '../util/html.js';
import type { LoadedFont } from './fontLoader.js';
import { templateFor, glyphFor, type TemplateId } from './hash.js';
import { IMAGE_ADJUST } from './render.js';
import { FONT_FACES, TEMPLATE_FONTS } from './fonts.js';
import type { CoverInput } from './render.js';

// Target cover dimensions (standard Kindle portrait)
const W = 1600;
const H = 2400;

// Scale CSS pixel values (templates designed for ~600px wide) to 1600px
function px(cssPixels: number): number {
  return Math.round(cssPixels * (W / 600));
}

interface TemplateCfg {
  gradient: Array<[number, string]>;
  headerBg: string | null;
  weekdaySize: number; // CSS px
  weekdayWeight: string;
  weekdayItalic: boolean;
  weekdayUppercase: boolean;
  weekdayLetterSpacing: string;
  folderSize: number;
  feedSize: number;
  feedUppercase: boolean;
  align: 'left' | 'center';
  bottomPad: number;
  sidePad: number;
}

const CFGS: Record<TemplateId, TemplateCfg> = {
  broadsheet: {
    gradient: [[0, 'rgba(0,0,0,0.55)'], [0.3, 'rgba(0,0,0,0)'], [0.65, 'rgba(0,0,0,0.55)'], [1, 'rgba(0,0,0,0.92)']],
    headerBg: '#000000',
    weekdaySize: 84, weekdayWeight: '900', weekdayItalic: false, weekdayUppercase: false, weekdayLetterSpacing: '-0.04em',
    folderSize: 20, feedSize: 13, feedUppercase: false,
    align: 'left', bottomPad: 28, sidePad: 28,
  },
  'the-drop': {
    gradient: [[0, 'rgba(0,0,0,0.65)'], [0.3, 'rgba(0,0,0,0)'], [0.65, 'rgba(0,0,0,0.60)'], [1, 'rgba(0,0,0,0.96)']],
    headerBg: null,
    weekdaySize: 118, weekdayWeight: '400', weekdayItalic: false, weekdayUppercase: true, weekdayLetterSpacing: '0.03em',
    folderSize: 17, feedSize: 10, feedUppercase: true,
    align: 'left', bottomPad: 30, sidePad: 28,
  },
  'the-review': {
    gradient: [[0, 'rgba(0,0,0,0.62)'], [0.35, 'rgba(0,0,0,0)'], [0.65, 'rgba(0,0,0,0.55)'], [1, 'rgba(0,0,0,0.94)']],
    headerBg: null,
    weekdaySize: 66, weekdayWeight: '400', weekdayItalic: true, weekdayUppercase: false, weekdayLetterSpacing: '-0.02em',
    folderSize: 17, feedSize: 12, feedUppercase: false,
    align: 'center', bottomPad: 34, sidePad: 40,
  },
  'the-signal': {
    gradient: [[0, 'rgba(0,0,0,0)'], [0.5, 'rgba(0,0,0,0)'], [0.65, 'rgba(0,0,0,0.55)'], [1, 'rgba(0,0,0,0.95)']],
    headerBg: '#000000',
    weekdaySize: 96, weekdayWeight: '700', weekdayItalic: false, weekdayUppercase: true, weekdayLetterSpacing: '0.01em',
    folderSize: 17, feedSize: 11, feedUppercase: true,
    align: 'left', bottomPad: 30, sidePad: 28,
  },
};

const FONT_FAMILIES: Record<TemplateId, string> = {
  broadsheet: "'Playfair Display', 'Liberation Serif', serif",
  'the-drop': "'Bebas Neue', 'Liberation Sans', sans-serif",
  'the-review': "'EB Garamond', 'Liberation Serif', serif",
  'the-signal': "'Oswald', 'Liberation Sans', sans-serif",
};

function buildFontFaceCss(templateId: TemplateId, fonts: LoadedFont[]): string {
  const neededFamily = TEMPLATE_FONTS[templateId];
  const fontMap = new Map(fonts.map((f) => [f.file, f.data]));
  return FONT_FACES.filter((f) => f.family === neededFamily)
    .map((face) => {
      const data = fontMap.get(face.file);
      if (!data) return '';
      return `@font-face{font-family:'${face.family}';font-weight:${face.weight};font-style:${face.style};src:url('data:font/woff2;base64,${data.toString('base64')}') format('woff2');}`;
    })
    .filter(Boolean)
    .join('');
}

function esc(s: string): string {
  return escapeHtml(s);
}

function buildHeaderElements(templateId: TemplateId, glyph: string, fontFamily: string): string[] {
  const els: string[] = [];
  const sp = px(28);

  switch (templateId) {
    case 'broadsheet': {
      const hh = px(54);
      els.push(`<rect x="0" y="0" width="${W}" height="${hh}" fill="#000"/>`);
      // Triple rule
      els.push(
        `<rect x="0" y="${hh}" width="${W}" height="${px(3)}" fill="white"/>`,
        `<rect x="0" y="${hh + px(5)}" width="${W}" height="${px(1)}" fill="white"/>`,
        `<rect x="0" y="${hh + px(8)}" width="${W}" height="${px(1)}" fill="white"/>`,
      );
      const ty = Math.round(hh * 0.66);
      els.push(
        `<text x="${sp}" y="${ty}" font-family="${fontFamily}" font-size="${px(15)}" fill="white" letter-spacing="${px(3)}px">DAILY DIGEST</text>`,
        `<text x="${W - sp}" y="${ty}" font-family="${fontFamily}" font-size="${px(20)}" fill="white" text-anchor="end">${esc(glyph)}</text>`,
      );
      break;
    }
    case 'the-drop': {
      const ty = px(24) + px(14);
      els.push(
        `<text x="${sp}" y="${ty}" font-family="${fontFamily}" font-size="${px(14)}" fill="rgba(255,255,255,0.5)" letter-spacing="${px(3)}px">DAILY DIGEST</text>`,
        `<text x="${W - sp}" y="${ty}" font-family="${fontFamily}" font-size="${px(18)}" fill="rgba(255,255,255,0.5)" text-anchor="end">${esc(glyph)}</text>`,
      );
      break;
    }
    case 'the-review': {
      const kickerY = px(30) + px(13);
      const glyphY = kickerY + px(32);
      const ruleY = glyphY + px(16);
      els.push(
        `<text x="${W / 2}" y="${kickerY}" font-family="${fontFamily}" font-size="${px(13)}" font-weight="600" fill="white" letter-spacing="${px(4)}px" text-anchor="middle">Daily Digest</text>`,
        `<text x="${W / 2}" y="${glyphY}" font-family="${fontFamily}" font-size="${px(22)}" fill="white" text-anchor="middle">${esc(glyph)}</text>`,
        `<line x1="${W / 2 - px(28)}" y1="${ruleY}" x2="${W / 2 + px(28)}" y2="${ruleY}" stroke="rgba(255,255,255,0.6)" stroke-width="2"/>`,
      );
      break;
    }
    case 'the-signal': {
      const hh = px(48);
      els.push(
        `<rect x="0" y="0" width="${W}" height="${hh}" fill="#000"/>`,
        `<rect x="0" y="${hh}" width="${W}" height="${px(4)}" fill="#555"/>`,
      );
      const ty = Math.round(hh * 0.66);
      els.push(
        `<text x="${sp}" y="${ty}" font-family="${fontFamily}" font-size="${px(15)}" font-weight="600" fill="white" letter-spacing="${px(1)}px">DAILY DIGEST</text>`,
        `<text x="${W - sp}" y="${ty}" font-family="${fontFamily}" font-size="${px(20)}" fill="white" text-anchor="end">${esc(glyph)}</text>`,
      );
      break;
    }
  }
  return els;
}

function buildBottomZone(
  _templateId: TemplateId,
  cfg: TemplateCfg,
  fontFamily: string,
  feeds: Array<{ name: string; count: number }>,
  weekday: string,
  folder: string,
  dateLabel: string,
): string[] {
  const els: string[] = [];
  const x = cfg.align === 'center' ? W / 2 : px(cfg.sidePad);
  const anchor = cfg.align === 'center' ? 'middle' : 'start';

  let y = H - px(cfg.bottomPad);

  // Feed list (max 8)
  const cappedFeeds = feeds.slice(0, 8);
  if (feeds.length > 8) cappedFeeds.push({ name: `…and ${feeds.length - 8} more`, count: 0 });
  const fSize = px(cfg.feedSize);
  const fLH = Math.round(fSize * 1.55);

  // Collect feed text elements bottom-to-top, then emit top-to-bottom
  const feedEls: string[] = [];
  for (let i = cappedFeeds.length - 1; i >= 0; i--) {
    const f = cappedFeeds[i];
    const label = cfg.feedUppercase ? f.name.toUpperCase() : f.name;
    const countStr = f.count > 0 ? `  ${f.count}` : '';
    feedEls.unshift(
      `<text x="${x}" y="${y}" font-family="${fontFamily}" font-size="${fSize}" fill="white" text-anchor="${anchor}" opacity="0.9">${esc(label + countStr)}</text>`,
    );
    y -= fLH;
  }
  els.push(...feedEls);

  // Divider
  y -= px(10);
  if (cfg.align === 'center') {
    const hw = px(80);
    els.push(`<line x1="${W / 2 - hw}" y1="${y}" x2="${W / 2 + hw}" y2="${y}" stroke="rgba(255,255,255,0.45)" stroke-width="${px(1)}"/>`);
  } else {
    els.push(`<line x1="${px(cfg.sidePad)}" y1="${y}" x2="${px(cfg.sidePad) + px(160)}" y2="${y}" stroke="rgba(255,255,255,0.45)" stroke-width="${px(1)}"/>`);
  }

  void dateLabel; // available for future use (e.g. theSignal date-in-divider)

  y -= px(14);

  // Folder subtitle
  const folderSize = px(cfg.folderSize);
  els.push(
    `<text x="${x}" y="${y}" font-family="${fontFamily}" font-size="${folderSize}" font-style="italic" fill="rgba(255,255,255,0.72)" text-anchor="${anchor}">${esc(folder)}</text>`,
  );
  y -= Math.round(folderSize * 1.3);

  // Weekday headline
  const wdSize = px(cfg.weekdaySize);
  const wdText = cfg.weekdayUppercase ? weekday.toUpperCase() : weekday;
  els.push(
    `<text x="${x}" y="${y}" font-family="${fontFamily}" font-size="${wdSize}" font-weight="${cfg.weekdayWeight}" font-style="${cfg.weekdayItalic ? 'italic' : 'normal'}" fill="white" text-anchor="${anchor}" letter-spacing="${cfg.weekdayLetterSpacing}">${esc(wdText)}</text>`,
  );

  return els;
}

function buildCoverSvg(
  templateId: TemplateId,
  input: CoverInput & { glyph: string },
  fonts: LoadedFont[],
): string {
  const cfg = CFGS[templateId];
  const fontFamily = FONT_FAMILIES[templateId];
  const fontFaceCss = buildFontFaceCss(templateId, fonts);

  const gradientStops = cfg.gradient
    .map(([offset, color]) => `<stop offset="${Math.round(offset * 100)}%" stop-color="${color}"/>`)
    .join('');

  const headerEls = buildHeaderElements(templateId, input.glyph, fontFamily);
  const bottomEls = buildBottomZone(templateId, cfg, fontFamily, input.feeds, input.weekday, input.folder, input.dateLabel);

  const decorationEls: string[] = [];
  if (templateId === 'the-review') {
    decorationEls.push(
      `<rect x="16" y="16" width="${W - 32}" height="${H - 32}" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="2"/>`,
      `<rect x="26" y="26" width="${W - 52}" height="${H - 52}" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="2"/>`,
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<defs>
<style>${fontFaceCss}</style>
<linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">${gradientStops}</linearGradient>
</defs>
<rect width="${W}" height="${H}" fill="url(#grad)"/>
${headerEls.join('\n')}
${decorationEls.join('\n')}
${bottomEls.join('\n')}
</svg>`;
}

/**
 * Build a 1600×2400 JPEG cover by compositing a template SVG overlay onto
 * the background image (or a solid dark base if no image is available).
 */
export async function buildCoverJpeg(
  input: CoverInput,
  backgroundRaw: Buffer | undefined,
  fonts: LoadedFont[],
): Promise<Buffer> {
  const templateId = templateFor(input.folder);
  const glyph = glyphFor(input.folder);
  const adjust = IMAGE_ADJUST[templateId];

  // Build base layer (1600×2400)
  const baseImg = backgroundRaw
    ? sharp(backgroundRaw)
        .grayscale()
        .linear(adjust.contrast, 128 - 128 * adjust.contrast)
        .modulate({ brightness: adjust.brightness })
        .resize({ width: W, height: H, fit: 'cover', position: 'centre' })
    : sharp({ create: { width: W, height: H, channels: 3, background: { r: 26, g: 26, b: 26 } } });

  // Build SVG overlay
  const svg = buildCoverSvg(templateId, { ...input, glyph }, fonts);

  return baseImg
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
}
