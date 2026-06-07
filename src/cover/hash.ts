/**
 * Stable template/glyph assignment for a folder's cover. The hash is a djb2
 * variant (multiply by 33, XOR the char code) masked to 32 bits. It must be
 * deterministic and identical to the spec so a folder's look never changes
 * day-to-day. Do not "improve" this without updating the cover tests.
 *
 *   h = 5381
 *   for c in folder_name: h = ((h * 33) XOR ord(c)) AND 0xFFFFFFFF
 *   template_index = abs(h) mod 4
 *   glyph_index    = abs(h) mod 8
 */

export const GLYPHS = ['◆', '●', '▲', '■', '◉', '✦', '※', '✶'] as const;

export const TEMPLATES = ['broadsheet', 'the-drop', 'the-review', 'the-signal'] as const;
export type TemplateId = (typeof TEMPLATES)[number];

export function folderHash(folderName: string): number {
  let h = 5381;
  for (const ch of folderName) {
    // JS numbers are doubles; keep the running value within 32-bit unsigned via
    // Math.imul for the *33 step, then XOR, then mask back to unsigned 32-bit.
    h = (Math.imul(h, 33) ^ ch.codePointAt(0)!) >>> 0;
  }
  return h;
}

export function templateIndex(folderName: string): number {
  return Math.abs(folderHash(folderName)) % 4;
}

export function glyphIndex(folderName: string): number {
  return Math.abs(folderHash(folderName)) % 8;
}

export function templateFor(folderName: string): TemplateId {
  return TEMPLATES[templateIndex(folderName)];
}

export function glyphFor(folderName: string): string {
  return GLYPHS[glyphIndex(folderName)];
}
