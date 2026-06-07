/**
 * Font registry. Single source of truth for both the cover @font-face CSS and
 * the `fetch-fonts` download script. All fonts are embedded as local woff2 in
 * the EPUB's fonts/ directory — never linked from a CDN.
 */

export interface FontFace {
  family: string;
  weight: number;
  style: 'normal' | 'italic';
  /** File name within assets/fonts/ and the EPUB fonts/ directory. */
  file: string;
  /** google-webfonts-helper variant id used by the download script. */
  gwfhFamily: string;
  gwfhVariant: string;
}

export const FONT_FACES: FontFace[] = [
  // Broadsheet — Playfair Display 900 (normal + italic)
  {
    family: 'Playfair Display',
    weight: 900,
    style: 'normal',
    file: 'PlayfairDisplay-900.woff2',
    gwfhFamily: 'playfair-display',
    gwfhVariant: '900',
  },
  {
    family: 'Playfair Display',
    weight: 900,
    style: 'italic',
    file: 'PlayfairDisplay-900italic.woff2',
    gwfhFamily: 'playfair-display',
    gwfhVariant: '900italic',
  },
  // The Drop — Bebas Neue 400
  {
    family: 'Bebas Neue',
    weight: 400,
    style: 'normal',
    file: 'BebasNeue-400.woff2',
    gwfhFamily: 'bebas-neue',
    gwfhVariant: 'regular',
  },
  // The Review — EB Garamond 400 italic + 600
  {
    family: 'EB Garamond',
    weight: 400,
    style: 'italic',
    file: 'EBGaramond-400italic.woff2',
    gwfhFamily: 'eb-garamond',
    gwfhVariant: 'italic',
  },
  {
    family: 'EB Garamond',
    weight: 600,
    style: 'normal',
    file: 'EBGaramond-600.woff2',
    gwfhFamily: 'eb-garamond',
    gwfhVariant: '600',
  },
  // The Signal — Oswald 600 + 700
  {
    family: 'Oswald',
    weight: 600,
    style: 'normal',
    file: 'Oswald-600.woff2',
    gwfhFamily: 'oswald',
    gwfhVariant: '600',
  },
  {
    family: 'Oswald',
    weight: 700,
    style: 'normal',
    file: 'Oswald-700.woff2',
    gwfhFamily: 'oswald',
    gwfhVariant: '700',
  },
];

/** @font-face block referencing fonts/ relative to the cover XHTML. */
export function fontFaceCss(faces: FontFace[] = FONT_FACES): string {
  return faces
    .map(
      (f) => `@font-face {
  font-family: '${f.family}';
  font-weight: ${f.weight};
  font-style: ${f.style};
  font-display: swap;
  src: url('fonts/${f.file}') format('woff2');
}`,
    )
    .join('\n');
}

/** Font families needed by each template (for scoping embedded faces). */
export const TEMPLATE_FONTS: Record<string, string> = {
  broadsheet: 'Playfair Display',
  'the-drop': 'Bebas Neue',
  'the-review': 'EB Garamond',
  'the-signal': 'Oswald',
};
