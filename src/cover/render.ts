import { escapeHtml } from '../util/html.js';
import type { ImageAdjust } from '../content/images.js';
import { glyphFor, templateFor, type TemplateId } from './hash.js';

/** Server-side grayscale image adjustments per template. */
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
}

export interface RenderedCover {
  templateId: TemplateId;
  glyph: string;
  xhtml: string;
}

/**
 * Build the cover spine XHTML. The visual content (text, gradient, background
 * photo) is pre-composited into images/cover.jpg by buildCoverJpeg; this page
 * simply displays that JPEG full-bleed.
 */
export function renderCover(input: CoverInput, templateOverride?: TemplateId | null): RenderedCover {
  const templateId = templateOverride ?? templateFor(input.folder);
  const glyph = glyphFor(input.folder);

  const xhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(input.folder)}</title>
  <style>html,body{margin:0;padding:0;width:100%;height:100%;}img{width:100%;height:100%;display:block;}</style>
</head>
<body>
  <img src="images/cover.jpg" alt="${escapeHtml(input.folder)} — ${escapeHtml(input.weekday)}" />
</body>
</html>`;

  return { templateId, glyph, xhtml };
}
