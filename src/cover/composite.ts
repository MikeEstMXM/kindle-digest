import sharp from 'sharp';
import { escapeHtml } from '../util/html.js';
import type { LoadedFont } from './fontLoader.js';
import { templateFor, glyphFor, type TemplateId } from './hash.js';
import { IMAGE_ADJUST } from './render.js';
import { FONT_FACES, TEMPLATE_FONTS } from './fonts.js';
import type { CoverInput } from './render.js';

// Target cover dimensions (Kindle Paperwhite 1072×1448 at 300ppi)
const W = 1072;
const H = 1448;

// Scale a percentage of cover width to pixels (matches the reference TSX's vw units)
function vw(pct: number): number {
  return Math.round((W * pct) / 100);
}
// Scale a percentage of cover height to pixels
function vh(pct: number): number {
  return Math.round((H * pct) / 100);
}

interface TemplateCfg {
  gradient: Array<[number, string]>;
  headerBg: string | null;
  weekdaySize: number; // vw%
  weekdayWeight: string;
  weekdayItalic: boolean;
  weekdayUppercase: boolean;
  weekdayLetterSpacing: string;
  folderSize: number; // vw%
  feedSize: number; // vw%
  feedUppercase: boolean;
  align: 'left' | 'center';
  bottomPad: number; // vh%
  sidePad: number; // vw%
}

const CFGS: Record<TemplateId, TemplateCfg> = {
  broadsheet: {
    gradient: [
      [0, 'rgba(0,0,0,0.55)'],
      [0.3, 'rgba(0,0,0,0)'],
      [0.65, 'rgba(0,0,0,0.55)'],
      [1, 'rgba(0,0,0,0.92)'],
    ],
    headerBg: '#000000',
    weekdaySize: 18,       // vw% — large serif, distinctive weight
    weekdayWeight: '900',
    weekdayItalic: false,
    weekdayUppercase: false,
    weekdayLetterSpacing: '-0.04em',
    folderSize: 5.5,       // vw% — large enough to read on thumbnail
    feedSize: 2.5,         // vw%
    feedUppercase: false,
    align: 'left',
    bottomPad: 5,          // vh%
    sidePad: 6,            // vw%
  },
  'the-drop': {
    gradient: [
      [0, 'rgba(0,0,0,0.65)'],
      [0.3, 'rgba(0,0,0,0)'],
      [0.65, 'rgba(0,0,0,0.60)'],
      [1, 'rgba(0,0,0,0.96)'],
    ],
    headerBg: null,
    weekdaySize: 24,       // vw% — massive condensed headline dominates the cover
    weekdayWeight: '400',
    weekdayItalic: false,
    weekdayUppercase: true,
    weekdayLetterSpacing: '0.03em',
    folderSize: 5.0,       // vw%
    feedSize: 2.0,         // vw%
    feedUppercase: true,
    align: 'left',
    bottomPad: 7,          // vh% — more breathing room at bottom
    sidePad: 6,            // vw%
  },
  'the-review': {
    gradient: [
      [0, 'rgba(0,0,0,0.62)'],
      [0.35, 'rgba(0,0,0,0)'],
      [0.65, 'rgba(0,0,0,0.55)'],
      [1, 'rgba(0,0,0,0.94)'],
    ],
    headerBg: null,
    weekdaySize: 17,       // vw% — italic serif, legible at full size and thumbnail
    weekdayWeight: '400',
    weekdayItalic: true,
    weekdayUppercase: false,
    weekdayLetterSpacing: '-0.02em',
    folderSize: 6,         // vw% — noticeably larger; center-aligned makes it feel refined
    feedSize: 2.5,         // vw%
    feedUppercase: false,
    align: 'center',
    bottomPad: 7,          // vh% — elegant spacing
    sidePad: 7,            // vw%
  },
  'the-signal': {
    gradient: [
      [0, 'rgba(0,0,0,0)'],
      [0.5, 'rgba(0,0,0,0)'],
      [0.65, 'rgba(0,0,0,0.55)'],
      [1, 'rgba(0,0,0,0.95)'],
    ],
    headerBg: '#000000',
    weekdaySize: 20,       // vw% — condensed all-caps, slightly smaller than the-drop
    weekdayWeight: '700',
    weekdayItalic: false,
    weekdayUppercase: true,
    weekdayLetterSpacing: '0.01em',
    folderSize: 5.0,       // vw%
    feedSize: 2.2,         // vw%
    feedUppercase: true,
    align: 'left',
    bottomPad: 5,          // vh%
    sidePad: 6,            // vw%
  },
};

const FONT_FAMILIES: Record<TemplateId, string> = {
  broadsheet: "'Playfair Display', 'Liberation Serif', serif",
  'the-drop': "'Bebas Neue','Oswald',Impact,'Arial Narrow',sans-serif",
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

function buildHeaderElements(
  templateId: TemplateId,
  glyph: string,
  fontFamily: string,
  theme: 'light' | 'dark',
): string[] {
  const tc = (dark: string, light: string) => (theme === 'dark' ? dark : light);
  const els: string[] = [];
  const sp = vw(6);

  switch (templateId) {
    case 'broadsheet': {
      const hh = vh(5.5);
      els.push(`<rect x="0" y="0" width="${W}" height="${hh}" fill="${tc('#000', '#e8e8e8')}"/>`);
      const ruleFill = tc('white', '#1a1a1a');
      els.push(
        `<rect x="0" y="${hh}" width="${W}" height="2" fill="${ruleFill}"/>`,
        `<rect x="0" y="${hh + 5}" width="${W}" height="1" fill="${ruleFill}"/>`,
        `<rect x="0" y="${hh + 8}" width="${W}" height="1" fill="${ruleFill}"/>`,
      );
      const ty = Math.round(hh * 0.66);
      const textFill = tc('white', '#1a1a1a');
      els.push(
        `<text x="${sp}" y="${ty}" font-family="${fontFamily}" font-size="${vw(1.8)}" fill="${textFill}" letter-spacing="3px">DAILY DIGEST</text>`,
        `<text x="${W - sp}" y="${ty}" font-family="${fontFamily}" font-size="${vw(3.5)}" fill="${textFill}" text-anchor="end">${esc(glyph)}</text>`,
      );
      break;
    }
    case 'the-drop': {
      const ty = vh(5.5) + vw(1.8);
      const textFill = tc('rgba(255,255,255,0.5)', 'rgba(0,0,0,0.5)');
      els.push(
        `<text x="${sp}" y="${ty}" font-family="${fontFamily}" font-size="${vw(1.8)}" fill="${textFill}" letter-spacing="3px">DAILY DIGEST</text>`,
        `<text x="${W - sp}" y="${ty}" font-family="${fontFamily}" font-size="${vw(3.5)}" fill="${textFill}" text-anchor="end">${esc(glyph)}</text>`,
      );
      break;
    }
    case 'the-review': {
      const kickerY = vh(5.5) + vw(1.8);
      const glyphY = kickerY + vw(3.5);
      const ruleY = glyphY + vw(2);
      const textFill = tc('white', '#1a1a1a');
      const ruleFill = tc('rgba(255,255,255,0.6)', 'rgba(0,0,0,0.6)');
      els.push(
        `<text x="${W / 2}" y="${kickerY}" font-family="${fontFamily}" font-size="${vw(1.8)}" font-weight="600" fill="${textFill}" letter-spacing="4px" text-anchor="middle">Daily Digest</text>`,
        `<text x="${W / 2}" y="${glyphY}" font-family="${fontFamily}" font-size="${vw(3.5)}" fill="${textFill}" text-anchor="middle">${esc(glyph)}</text>`,
        `<line x1="${W / 2 - vw(6)}" y1="${ruleY}" x2="${W / 2 + vw(6)}" y2="${ruleY}" stroke="${ruleFill}" stroke-width="2"/>`,
      );
      break;
    }
    case 'the-signal': {
      const hh = vh(5.5);
      els.push(
        `<rect x="0" y="0" width="${W}" height="${hh}" fill="${tc('#000', '#e8e8e8')}"/>`,
        `<rect x="0" y="${hh}" width="${W}" height="4" fill="${tc('#555', '#999')}"/>`,
      );
      const ty = Math.round(hh * 0.66);
      const textFill = tc('white', '#1a1a1a');
      els.push(
        `<text x="${sp}" y="${ty}" font-family="${fontFamily}" font-size="${vw(1.8)}" font-weight="600" fill="${textFill}" letter-spacing="1px">DAILY DIGEST</text>`,
        `<text x="${W - sp}" y="${ty}" font-family="${fontFamily}" font-size="${vw(3.5)}" fill="${textFill}" text-anchor="end">${esc(glyph)}</text>`,
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
  theme: 'light' | 'dark',
): string[] {
  const tc = (dark: string, light: string) => (theme === 'dark' ? dark : light);
  const els: string[] = [];
  const x = cfg.align === 'center' ? W / 2 : vw(cfg.sidePad);
  const anchor = cfg.align === 'center' ? 'middle' : 'start';

  let y = H - Math.round((H * cfg.bottomPad) / 100);

  // Feed list (max 8)
  const cappedFeeds = feeds.slice(0, 8);
  if (feeds.length > 8) cappedFeeds.push({ name: `…and ${feeds.length - 8} more`, count: 0 });
  const fSize = vw(cfg.feedSize);
  const fLH = Math.round(fSize * 1.55);

  const feedFill = tc('white', '#1a1a1a');
  const feedEls: string[] = [];
  for (let i = cappedFeeds.length - 1; i >= 0; i--) {
    const f = cappedFeeds[i];
    const label = cfg.feedUppercase ? f.name.toUpperCase() : f.name;
    const countStr = f.count > 0 ? `  ${f.count}` : '';
    feedEls.unshift(
      `<text x="${x}" y="${y}" font-family="${fontFamily}" font-size="${fSize}" fill="${feedFill}" text-anchor="${anchor}" opacity="0.9">${esc(label + countStr)}</text>`,
    );
    y -= fLH;
  }
  els.push(...feedEls);

  // Divider
  y -= Math.round(H * 0.01);
  const dividerStroke = tc('rgba(255,255,255,0.45)', 'rgba(0,0,0,0.45)');
  if (cfg.align === 'center') {
    const hw = vw(15);
    els.push(
      `<line x1="${W / 2 - hw}" y1="${y}" x2="${W / 2 + hw}" y2="${y}" stroke="${dividerStroke}" stroke-width="1"/>`,
    );
  } else {
    els.push(
      `<line x1="${vw(cfg.sidePad)}" y1="${y}" x2="${vw(cfg.sidePad) + vw(15)}" y2="${y}" stroke="${dividerStroke}" stroke-width="1"/>`,
    );
  }

  void dateLabel; // available for future use (e.g. theSignal date-in-divider)

  y -= Math.round(H * 0.01);

  // Folder subtitle
  const folderSize = vw(cfg.folderSize);
  const folderFill = tc('rgba(255,255,255,0.72)', 'rgba(0,0,0,0.72)');
  els.push(
    `<text x="${x}" y="${y}" font-family="${fontFamily}" font-size="${folderSize}" font-style="italic" fill="${folderFill}" text-anchor="${anchor}">${esc(folder)}</text>`,
  );
  y -= Math.round(folderSize * 1.3);

  // Weekday headline
  const wdSize = vw(cfg.weekdaySize);
  const wdText = cfg.weekdayUppercase ? weekday.toUpperCase() : weekday;
  const weekdayFill = tc('white', '#1a1a1a');
  els.push(
    `<text x="${x}" y="${y}" font-family="${fontFamily}" font-size="${wdSize}" font-weight="${cfg.weekdayWeight}" font-style="${cfg.weekdayItalic ? 'italic' : 'normal'}" fill="${weekdayFill}" text-anchor="${anchor}" letter-spacing="${cfg.weekdayLetterSpacing}">${esc(wdText)}</text>`,
  );

  return els;
}

// Per-template image adjustments for light theme (brighten, reduce contrast).
const IMAGE_ADJUST_LIGHT: Record<TemplateId, { contrast: number; brightness: number }> = {
  broadsheet:   { contrast: 0.85, brightness: 1.5 },
  'the-drop':   { contrast: 0.8,  brightness: 2.0 },
  'the-review': { contrast: 0.85, brightness: 1.6 },
  'the-signal': { contrast: 0.85, brightness: 1.5 },
};

function buildCoverSvg(
  templateId: TemplateId,
  input: CoverInput & { glyph: string },
  fonts: LoadedFont[],
  theme: 'light' | 'dark',
): string {
  const cfg = CFGS[templateId];
  const fontFamily = FONT_FAMILIES[templateId];
  const fontFaceCss = buildFontFaceCss(templateId, fonts);

  const gradBase = theme === 'light' ? '255,255,255' : '0,0,0';
  const gradientStops = cfg.gradient
    .map(([offset, color]) => {
      const c = theme === 'light' ? color.replace('0,0,0', gradBase) : color;
      return `<stop offset="${Math.round(offset * 100)}%" stop-color="${c}"/>`;
    })
    .join('');

  const headerEls = buildHeaderElements(templateId, input.glyph, fontFamily, theme);
  const bottomEls = buildBottomZone(
    templateId,
    cfg,
    fontFamily,
    input.feeds,
    input.weekday,
    input.folder,
    input.dateLabel,
    theme,
  );

  const decorationEls: string[] = [];
  if (templateId === 'the-review') {
    const tc = (dark: string, light: string) => (theme === 'dark' ? dark : light);
    decorationEls.push(
      `<rect x="${vw(1.5)}" y="${vw(1.5)}" width="${W - vw(3)}" height="${H - vw(3)}" fill="none" stroke="${tc('rgba(255,255,255,0.5)', 'rgba(0,0,0,0.5)')}" stroke-width="2"/>`,
      `<rect x="${vw(2.5)}" y="${vw(2.5)}" width="${W - vw(5)}" height="${H - vw(5)}" fill="none" stroke="${tc('rgba(255,255,255,0.22)', 'rgba(0,0,0,0.22)')}" stroke-width="2"/>`,
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
 * Build a 1072×1448 JPEG cover by compositing a template SVG overlay onto
 * the background image (or a solid base if no image is available).
 */
export async function buildCoverJpeg(
  input: CoverInput,
  backgroundRaw: Buffer | undefined,
  fonts: LoadedFont[],
  templateOverride?: TemplateId | null,
  theme: 'light' | 'dark' = 'dark',
): Promise<Buffer> {
  const templateId = templateOverride ?? templateFor(input.folder);
  const glyph = glyphFor(input.folder);
  const adjustTable = theme === 'light' ? IMAGE_ADJUST_LIGHT : IMAGE_ADJUST;
  const adjust = adjustTable[templateId];

  const baseColor = theme === 'light' ? { r: 245, g: 245, b: 245 } : { r: 26, g: 26, b: 26 };

  // Build base layer (1072×1448)
  const baseImg = backgroundRaw
    ? sharp(backgroundRaw)
        .grayscale()
        .linear(adjust.contrast, 128 - 128 * adjust.contrast)
        .modulate({ brightness: adjust.brightness })
        .resize({ width: W, height: H, fit: 'cover', position: 'centre' })
    : sharp({ create: { width: W, height: H, channels: 3, background: baseColor } });

  // Build SVG overlay
  const svg = buildCoverSvg(templateId, { ...input, glyph }, fonts, theme);

  return baseImg
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
}
