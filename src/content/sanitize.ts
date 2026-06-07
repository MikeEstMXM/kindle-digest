import { JSDOM } from 'jsdom';

const STRIP_TAGS = ['script', 'style', 'iframe', 'noscript', 'svg', 'video', 'audio', 'form'];

/**
 * Normalise article HTML into well-formed XHTML safe to embed in an EPUB.
 *
 * - Removes scripts/embeds that have no meaning on e-ink.
 * - Removes <img> elements: V1 EPUBs are self-contained and we do not bundle
 *   every in-article asset; the per-article QR links to the original for full
 *   fidelity (documented limitation). The cover image IS embedded separately.
 * - Re-serialises via XMLSerializer so the output is valid XHTML (self-closed
 *   voids, escaped entities) — EPUB readers reject malformed XML.
 */
export function sanitizeArticleHtml(html: string): string {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`);
  const { document, XMLSerializer } = dom.window;

  for (const tag of STRIP_TAGS) {
    document.querySelectorAll(tag).forEach((el) => el.remove());
  }
  // Replace images with their alt text (if any) so captions survive.
  document.querySelectorAll('img').forEach((img) => {
    const alt = img.getAttribute('alt');
    if (alt && alt.trim()) {
      const em = document.createElement('em');
      em.textContent = `[image: ${alt.trim()}]`;
      img.replaceWith(em);
    } else {
      img.remove();
    }
  });
  // Drop event-handler / style attributes.
  document.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) {
      if (attr.name.startsWith('on') || attr.name === 'style' || attr.name === 'class') {
        el.removeAttribute(attr.name);
      }
    }
  });

  const serializer = new XMLSerializer();
  return [...document.body.childNodes]
    .map((n) => serializer.serializeToString(n))
    .join('')
    .trim();
}
