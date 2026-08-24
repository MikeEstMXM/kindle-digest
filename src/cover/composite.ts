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

// Title block fit-to-width budget, shared by all four templates: full width minus
// the 64px side margin on each side.
const TITLE_BUDGET = W - 2 * vw(6);

interface FeedCfg {
  size: number;
  weight?: string;
  uppercase: boolean;
  lineHeight: number;
  bottomPad: number; // vh%
  align: 'left' | 'center';
  sidePad: number; // vw%
}

const FEED_CFGS: Record<TemplateId, FeedCfg> = {
  broadsheet: { size: 27, weight: '400', uppercase: false, lineHeight: 42, bottomPad: 5, align: 'left', sidePad: 6 },
  'the-drop': { size: 21, uppercase: true, lineHeight: 33, bottomPad: 7, align: 'left', sidePad: 6 },
  'the-review': { size: 27, uppercase: false, lineHeight: 42, bottomPad: 7, align: 'center', sidePad: 7 },
  'the-signal': { size: 23, weight: '400', uppercase: true, lineHeight: 37, bottomPad: 5, align: 'left', sidePad: 6 },
};

const GRADIENTS: Record<TemplateId, Array<[number, string]>> = {
  broadsheet: [
    [0, 'rgba(0,0,0,0.55)'],
    [0.24, 'rgba(0,0,0,0)'],
    [0.76, 'rgba(0,0,0,0)'],
    [0.84, 'rgba(0,0,0,0.75)'],
    [1, 'rgba(0,0,0,0.96)'],
  ],
  'the-drop': [
    [0, 'rgba(0,0,0,0.65)'],
    [0.24, 'rgba(0,0,0,0)'],
    [0.8, 'rgba(0,0,0,0)'],
    [0.86, 'rgba(0,0,0,0.78)'],
    [1, 'rgba(0,0,0,0.97)'],
  ],
  'the-review': [
    [0, 'rgba(0,0,0,0.62)'],
    [0.28, 'rgba(0,0,0,0)'],
    [0.72, 'rgba(0,0,0,0)'],
    [0.8, 'rgba(0,0,0,0.75)'],
    [1, 'rgba(0,0,0,0.96)'],
  ],
  'the-signal': [
    [0, 'rgba(0,0,0,0)'],
    [0.76, 'rgba(0,0,0,0)'],
    [0.84, 'rgba(0,0,0,0.75)'],
    [1, 'rgba(0,0,0,0.96)'],
  ],
};

const FONT_FAMILIES: Record<TemplateId, string> = {
  broadsheet: "'Playfair Display', 'Liberation Serif', serif",
  'the-drop': "'Bebas Neue','Oswald',Impact,'Arial Narrow',sans-serif",
  'the-review': "'EB Garamond', 'Liberation Serif', serif",
  'the-signal': "'Bricolage Grotesque', 'Liberation Sans', sans-serif",
};

// Average glyph-advance ratio (advance width / font size) per template face,
// calibrated against the sample strings in the design prototype ("World News",
// "Culture", "Longreads", "Tech & Startups"). sharp/librsvg has no text
// measurement API, so this is an estimate, not exact metrics — err on the
// side of shrinking a title rather than letting it overflow.
const TITLE_WIDTH_RATIO: Record<TemplateId, number> = {
  broadsheet: 0.56,
  'the-drop': 0.72,
  'the-review': 0.48,
  'the-signal': 0.62,
};

function estimateTextWidth(text: string, size: number, ratio: number, letterSpacingEm: number): number {
  const n = text.length;
  return n * size * ratio + Math.max(0, n - 1) * letterSpacingEm * size;
}

/** Shrink (never wrap) until the text fits the shared title budget. */
function fitShrinkOnly(text: string, maxSize: number, ratio: number, letterSpacingEm: number): number {
  let size = maxSize;
  while (size > 16 && estimateTextWidth(text, size, ratio, letterSpacingEm) > TITLE_BUDGET) {
    size -= 2;
  }
  return size;
}

/** Split on the last space that keeps line 1 under the width budget; never mid-word. */
function splitAtSpace(text: string, size: number, ratio: number, letterSpacingEm: number): [string, string] {
  const words = text.split(' ');
  if (words.length < 2) return [text, ''];
  let splitIdx = 1;
  for (let i = 1; i < words.length; i++) {
    const candidate = words.slice(0, i).join(' ');
    if (estimateTextWidth(candidate, size, ratio, letterSpacingEm) <= TITLE_BUDGET) splitIdx = i;
    else break;
  }
  return [words.slice(0, splitIdx).join(' '), words.slice(splitIdx).join(' ')];
}

interface SignalFit {
  lines: string[];
  size: number;
}

/**
 * The Signal's title sizing: shrink from `maxSize` down to ~75% of it looking
 * for a single-line fit; if it's still too wide there, wrap to two lines at
 * that size and keep shrinking both lines together if needed. Caps at two lines.
 */
function fitSignalTitle(text: string, maxSize: number, ratio: number, letterSpacingEm: number): SignalFit {
  const floor = Math.round(maxSize * 0.75);
  let size = maxSize;
  while (size > floor && estimateTextWidth(text, size, ratio, letterSpacingEm) > TITLE_BUDGET) {
    size -= 2;
  }
  if (estimateTextWidth(text, size, ratio, letterSpacingEm) <= TITLE_BUDGET) {
    return { lines: [text], size };
  }

  size = floor;
  let [line1, line2] = splitAtSpace(text, size, ratio, letterSpacingEm);
  while (
    size > 16 &&
    (estimateTextWidth(line1, size, ratio, letterSpacingEm) > TITLE_BUDGET ||
      estimateTextWidth(line2, size, ratio, letterSpacingEm) > TITLE_BUDGET)
  ) {
    size -= 2;
    [line1, line2] = splitAtSpace(text, size, ratio, letterSpacingEm);
  }
  return { lines: line2 ? [line1, line2] : [line1], size };
}

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
        `<text x="${sp}" y="${ty}" font-family="${fontFamily}" font-size="18" font-weight="800" fill="${textFill}" letter-spacing="2px">DAILY DIGEST</text>`,
        `<text x="${W - sp}" y="${ty}" font-family="${fontFamily}" font-size="${vw(3.5)}" fill="${textFill}" text-anchor="end">${esc(glyph)}</text>`,
      );
      break;
    }
  }
  return els;
}

/** 1a — broadsheet: masthead position, title/date stacked under the triple rule. */
function buildBroadsheetTitle(input: CoverInput, theme: 'light' | 'dark'): string[] {
  const tc = (dark: string, light: string) => (theme === 'dark' ? dark : light);
  const fontFamily = FONT_FAMILIES.broadsheet;
  const x = vw(6);
  const size = fitShrinkOnly(input.folder, 140, TITLE_WIDTH_RATIO.broadsheet, -0.035);
  const titleFill = tc('white', '#1a1a1a');
  const dateFill = tc('rgba(255,255,255,0.92)', 'rgba(0,0,0,0.92)');
  const ruleFill = tc('white', '#1a1a1a');
  const hairlineFill = tc('rgba(255,255,255,0.85)', 'rgba(0,0,0,0.85)');
  return [
    `<g filter="url(#tshadow)">`,
    `<text x="${x}" y="250" font-family="${fontFamily}" font-size="${size}" font-weight="900" letter-spacing="-0.035em" fill="${titleFill}">${esc(input.folder)}</text>`,
    `<text x="${x}" y="352" font-family="${fontFamily}" font-size="92" font-weight="400" font-style="italic" fill="${dateFill}">${esc(input.dateLabel)}</text>`,
    `<rect x="${x}" y="398" width="944" height="3" fill="${ruleFill}"/>`,
    `<rect x="${x}" y="406" width="944" height="1" fill="${hairlineFill}"/>`,
    `</g>`,
  ];
}

/** 1b — the-drop: optical centre, black stroke halo instead of a drop shadow. */
function buildDropTitle(input: CoverInput, theme: 'light' | 'dark'): string[] {
  const tc = (dark: string, light: string) => (theme === 'dark' ? dark : light);
  const fontFamily = FONT_FAMILIES['the-drop'];
  const x = vw(6);
  const titleText = input.folder.toUpperCase();
  const dateText = input.dateLabel.toUpperCase();
  const size = fitShrinkOnly(titleText, 230, TITLE_WIDTH_RATIO['the-drop'], 0.02);
  const textFill = tc('white', '#1a1a1a');
  const halo = tc('#000', '#fff');
  return [
    `<g filter="url(#tshadow)">`,
    `<text x="${x}" y="720" font-family="${fontFamily}" font-size="${size}" letter-spacing="0.02em" fill="${textFill}" paint-order="stroke" stroke="${halo}" stroke-width="16" stroke-opacity="0.55" stroke-linejoin="round">${esc(titleText)}</text>`,
    `<text x="${x}" y="828" font-family="${fontFamily}" font-size="86" letter-spacing="0.06em" fill="${textFill}" paint-order="stroke" stroke="${halo}" stroke-width="10" stroke-opacity="0.55" stroke-linejoin="round">${esc(dateText)}</text>`,
    `</g>`,
  ];
}

/** 1c — the-review: upper third, ruled above and below, centre-aligned. */
function buildReviewTitle(input: CoverInput, theme: 'light' | 'dark'): string[] {
  const tc = (dark: string, light: string) => (theme === 'dark' ? dark : light);
  const fontFamily = FONT_FAMILIES['the-review'];
  const cx = W / 2;
  const size = fitShrinkOnly(input.folder, 150, TITLE_WIDTH_RATIO['the-review'], -0.02);
  const titleFill = tc('white', '#1a1a1a');
  const dateFill = tc('rgba(255,255,255,0.92)', 'rgba(0,0,0,0.92)');
  const ruleStroke = tc('rgba(255,255,255,0.8)', 'rgba(0,0,0,0.8)');
  const half = vw(15);
  return [
    `<g filter="url(#tshadow)">`,
    `<line x1="${cx - half}" y1="452" x2="${cx + half}" y2="452" stroke="${ruleStroke}" stroke-width="2"/>`,
    `<text x="${cx}" y="592" font-family="${fontFamily}" font-size="${size}" font-style="italic" letter-spacing="-0.02em" fill="${titleFill}" text-anchor="middle">${esc(input.folder)}</text>`,
    `<text x="${cx}" y="690" font-family="${fontFamily}" font-size="84" font-style="italic" fill="${dateFill}" text-anchor="middle">${esc(input.dateLabel)}</text>`,
    `<line x1="${cx - half}" y1="738" x2="${cx + half}" y2="738" stroke="${ruleStroke}" stroke-width="2"/>`,
    `</g>`,
  ];
}

/** 1d — the-signal: full-bleed black chyron, rule to rule. Height follows line count. */
function buildSignalTitle(input: CoverInput, theme: 'light' | 'dark'): string[] {
  const tc = (dark: string, light: string) => (theme === 'dark' ? dark : light);
  const fontFamily = FONT_FAMILIES['the-signal'];
  const x = vw(6);
  const titleText = input.folder.toUpperCase();
  const dateText = input.dateLabel.toUpperCase();
  const fit = fitSignalTitle(titleText, 150, TITLE_WIDTH_RATIO['the-signal'], -0.02);
  const lines = fit.lines.length;

  const lineAdvance = 138;
  const plateTop = 618;
  const plateH = 390 - (2 - lines) * lineAdvance;
  const titleBase1 = plateTop + 140;
  const dateBase = titleBase1 + (lines - 1) * lineAdvance + 82;
  const topRuleY = plateTop - 4;
  const bottomRuleY = plateTop + plateH;

  const ruleFill = tc('#555', '#999');
  const plateFill = tc('#000', '#e8e8e8');
  const titleFill = tc('white', '#1a1a1a');
  const dateFill = tc('rgba(255,255,255,0.9)', 'rgba(0,0,0,0.9)');

  const els: string[] = [
    `<rect x="0" y="${topRuleY}" width="${W}" height="4" fill="${ruleFill}"/>`,
    `<rect x="0" y="${plateTop}" width="${W}" height="${plateH}" fill="${plateFill}" opacity="0.86"/>`,
    `<rect x="0" y="${bottomRuleY}" width="${W}" height="4" fill="${ruleFill}"/>`,
  ];
  fit.lines.forEach((line, i) => {
    const y = titleBase1 + i * lineAdvance;
    els.push(
      `<text x="${x}" y="${y}" font-family="${fontFamily}" font-size="${fit.size}" font-weight="800" letter-spacing="-0.02em" fill="${titleFill}">${esc(line)}</text>`,
    );
  });
  els.push(
    `<text x="${x}" y="${dateBase}" font-family="${fontFamily}" font-size="78" font-weight="500" letter-spacing="0.01em" fill="${dateFill}">${esc(dateText)}</text>`,
  );
  return els;
}

const TITLE_BUILDERS: Record<TemplateId, (input: CoverInput, theme: 'light' | 'dark') => string[]> = {
  broadsheet: buildBroadsheetTitle,
  'the-drop': buildDropTitle,
  'the-review': buildReviewTitle,
  'the-signal': buildSignalTitle,
};

function buildFeedList(
  cfg: FeedCfg,
  fontFamily: string,
  feeds: Array<{ name: string; count: number }>,
  theme: 'light' | 'dark',
): string[] {
  const tc = (dark: string, light: string) => (theme === 'dark' ? dark : light);
  const x = cfg.align === 'center' ? W / 2 : vw(cfg.sidePad);
  const anchor = cfg.align === 'center' ? 'middle' : 'start';
  let y = H - vh(cfg.bottomPad);

  const cappedFeeds = feeds.slice(0, 8);
  if (feeds.length > 8) cappedFeeds.push({ name: `…and ${feeds.length - 8} more`, count: 0 });

  const feedFill = tc('white', '#1a1a1a');
  const weightAttr = cfg.weight ? ` font-weight="${cfg.weight}"` : '';
  const feedEls: string[] = [];
  for (let i = cappedFeeds.length - 1; i >= 0; i--) {
    const f = cappedFeeds[i];
    const label = cfg.uppercase ? f.name.toUpperCase() : f.name;
    const countStr = f.count > 0 ? `  ${f.count}` : '';
    feedEls.unshift(
      `<text x="${x}" y="${y}" font-family="${fontFamily}" font-size="${cfg.size}"${weightAttr} fill="${feedFill}" text-anchor="${anchor}" opacity="0.9">${esc(label + countStr)}</text>`,
    );
    y -= cfg.lineHeight;
  }
  return feedEls;
}

// Per-template image adjustments for light theme (brighten, reduce contrast).
const IMAGE_ADJUST_LIGHT: Record<TemplateId, { contrast: number; brightness: number }> = {
  broadsheet:   { contrast: 0.85, brightness: 1.5 },
  'the-drop':   { contrast: 0.8,  brightness: 2.0 },
  'the-review': { contrast: 0.85, brightness: 1.6 },
  'the-signal': { contrast: 0.85, brightness: 1.5 },
};

export function buildCoverSvg(
  templateId: TemplateId,
  input: CoverInput & { glyph: string },
  fonts: LoadedFont[],
  theme: 'light' | 'dark',
): string {
  const fontFamily = FONT_FAMILIES[templateId];
  const fontFaceCss = buildFontFaceCss(templateId, fonts);

  const gradBase = theme === 'light' ? '255,255,255' : '0,0,0';
  const gradientStops = GRADIENTS[templateId]
    .map(([offset, color]) => {
      const c = theme === 'light' ? color.replace('0,0,0', gradBase) : color;
      return `<stop offset="${Math.round(offset * 100)}%" stop-color="${c}"/>`;
    })
    .join('');

  // The drop-shadow / stroke-halo contrast treatments below are specified for
  // dark theme only; for light theme we flip the flood color the same way the
  // rest of this file flips ink colors, so the shadow still reads as a halo
  // rather than a smudge under dark-on-light text.
  const shadowFlood = theme === 'light' ? '#fff' : '#000';

  const headerEls = buildHeaderElements(templateId, input.glyph, fontFamily, theme);
  const titleEls = TITLE_BUILDERS[templateId](input, theme);
  const feedEls = buildFeedList(FEED_CFGS[templateId], fontFamily, input.feeds, theme);

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
<filter id="tshadow" x="-25%" y="-25%" width="150%" height="150%"><feDropShadow dx="0" dy="5" stdDeviation="14" flood-color="${shadowFlood}" flood-opacity="0.85"/></filter>
</defs>
<rect width="${W}" height="${H}" fill="url(#grad)"/>
${headerEls.join('\n')}
${decorationEls.join('\n')}
${titleEls.join('\n')}
${feedEls.join('\n')}
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
