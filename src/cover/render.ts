import { escapeHtml } from '../util/html.js';
import type { ImageAdjust } from '../content/images.js';
import { fontFaceCss } from './fonts.js';
import { glyphFor, templateFor, type TemplateId } from './hash.js';
import { renderTemplate, sharedCss, type CoverData } from './templates.js';

/** Server-side grayscale image adjustments per template (per Cover Design Spec). */
export const IMAGE_ADJUST: Record<TemplateId, ImageAdjust> = {
  broadsheet: { contrast: 1.1, brightness: 0.72 },
  'the-drop': { contrast: 1.3, brightness: 0.32 },
  'the-review': { contrast: 1.05, brightness: 0.68 },
  'the-signal': { contrast: 1.15, brightness: 0.72 },
};

export interface CoverInput {
  folder: string;
  weekday: string;
  isoDate: string;
  dateLabel: string;
  feeds: { name: string; count: number }[];
  backgroundImageHref?: string;
}

export interface RenderedCover {
  templateId: TemplateId;
  glyph: string;
  xhtml: string;
}

/** Build the full, self-contained cover XHTML (spine item #1). */
export function renderCover(input: CoverInput): RenderedCover {
  const templateId = templateFor(input.folder);
  const glyph = glyphFor(input.folder);
  const data: CoverData = { ...input, glyph };
  const pieces = renderTemplate(templateId, data);

  const background = input.backgroundImageHref
    ? `<img class="bg" src="${escapeHtml(input.backgroundImageHref)}" alt="" />`
    : `<div class="crosshatch"></div>`;

  const css = `${fontFaceCss()}\n\n${sharedCss()}\n\n${pieces.css}`;

  const xhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(input.folder)} — ${escapeHtml(input.weekday)}</title>
  <style>
${css}
  </style>
</head>
<body>
  <div class="cover">
    ${background}
    <div class="overlay"></div>
    ${pieces.decorationHtml ? pieces.decorationHtml + '\n    ' : ''}<div class="content">
    ${pieces.contentHtml}
    </div>
  </div>
</body>
</html>`;

  return { templateId, glyph, xhtml };
}
