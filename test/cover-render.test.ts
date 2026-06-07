import { describe, it, expect } from 'vitest';
import { renderCover } from '../src/cover/render.js';
import { TEMPLATES, templateFor, glyphFor } from '../src/cover/hash.js';
import { TEMPLATE_FONTS } from '../src/cover/fonts.js';

function sampleInput(folder: string, withImage = true) {
  return {
    folder,
    weekday: 'Saturday',
    isoDate: '2026-06-07',
    dateLabel: 'June 7, 2026',
    feeds: [
      { name: 'Ars Technica', count: 4 },
      { name: 'The Verge', count: 2 },
    ],
    backgroundImageHref: withImage ? 'images/cover.jpg' : undefined,
  };
}

/** Find one folder name that hashes to each template, for full coverage. */
function folderForTemplate(idx: number): string {
  for (let i = 0; i < 5000; i++) {
    const name = `folder-${i}`;
    if (TEMPLATES.indexOf(templateFor(name)) === idx) return name;
  }
  throw new Error(`no folder found for template ${idx}`);
}

describe('cover rendering', () => {
  it('embeds @font-face with local woff2 (no external CDN)', () => {
    const { xhtml } = renderCover(sampleInput('Technology'));
    expect(xhtml).toContain('@font-face');
    expect(xhtml).toMatch(/url\('fonts\/[^']+\.woff2'\)/);
    expect(xhtml).not.toMatch(/https?:\/\/fonts\.g/i);
    expect(xhtml).not.toContain('cdn');
  });

  it('renders the correct template font for each template', () => {
    for (let i = 0; i < TEMPLATES.length; i++) {
      const folder = folderForTemplate(i);
      const { templateId, xhtml } = renderCover(sampleInput(folder));
      expect(templateId).toBe(TEMPLATES[i]);
      expect(xhtml).toContain(`font-family: '${TEMPLATE_FONTS[templateId]}'`);
    }
  });

  it('places weekday (title) and folder (subtitle) as adjacent siblings', () => {
    const { xhtml } = renderCover(sampleInput('Technology'));
    // weekday div immediately followed by folder div inside title-block.
    expect(xhtml).toMatch(
      /<div class="weekday">Saturday<\/div>\s*<div class="folder">Technology<\/div>/,
    );
  });

  it('keeps title-block before divider before feed-list (no overlap, flex spacer present)', () => {
    const { xhtml } = renderCover(sampleInput('Technology'));
    const spacer = xhtml.indexOf('class="spacer"');
    const title = xhtml.indexOf('class="title-block"');
    const divider = xhtml.indexOf('class="divider"');
    const feeds = xhtml.indexOf('class="feed-list"');
    expect(spacer).toBeGreaterThan(-1);
    expect(spacer).toBeLessThan(title);
    expect(title).toBeLessThan(divider);
    expect(divider).toBeLessThan(feeds);
    expect(xhtml).toContain('flex: 1');
  });

  it('renders the feed list with names, counts and 40% max-width', () => {
    const { xhtml } = renderCover(sampleInput('Technology'));
    expect(xhtml).toContain('max-width: 40%');
    expect(xhtml).toContain('Ars Technica');
    expect(xhtml).toMatch(/<span class="feed-count">4<\/span>/);
    expect(xhtml).toContain('justify-content: space-between');
  });

  it('applies the required text-shadow to text over the image', () => {
    const { xhtml } = renderCover(sampleInput('Technology'));
    expect(xhtml).toContain('text-shadow: 0 1px 6px rgba(0,0,0,0.65), 0 0 14px rgba(0,0,0,0.35)');
  });

  it('uses the stable glyph for the folder', () => {
    const { xhtml, glyph } = renderCover(sampleInput('Technology'));
    expect(glyph).toBe(glyphFor('Technology'));
    expect(xhtml).toContain(glyph);
  });

  it('falls back to crosshatch when no image is provided', () => {
    const { xhtml } = renderCover(sampleInput('Technology', false));
    expect(xhtml).toContain('class="crosshatch"');
    expect(xhtml).not.toContain('class="bg"');
  });

  it('The Review adds the double border decoration and ornament', () => {
    const review = folderForTemplate(TEMPLATES.indexOf('the-review'));
    const { xhtml } = renderCover(sampleInput(review));
    expect(xhtml).toContain('border-outer');
    expect(xhtml).toContain('border-inner');
    expect(xhtml).toContain('· · ·');
    expect(xhtml).toContain('inset: 6px');
    expect(xhtml).toContain('inset: 10px');
  });

  it('The Signal divider is [rule][date][rule]', () => {
    const signal = folderForTemplate(TEMPLATES.indexOf('the-signal'));
    const { xhtml } = renderCover(sampleInput(signal));
    expect(xhtml).toMatch(
      /<div class="divider"><span class="rule"><\/span><span class="date">June 7, 2026<\/span><span class="rule"><\/span><\/div>/,
    );
  });
});
