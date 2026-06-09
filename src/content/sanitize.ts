import { JSDOM } from 'jsdom';

const STRIP_TAGS = ['script', 'style', 'iframe', 'noscript', 'svg', 'video', 'audio', 'form'];

export interface SanitizeResult {
  xhtml: string;
  /** Original src URLs for HTTP images found in the article body. Parallel to
   *  %%img-N%% placeholder tokens left in xhtml so the orchestrator can
   *  download, process, and substitute them. */
  imageUrls: string[];
}

/**
 * Normalise article HTML into well-formed XHTML safe to embed in an EPUB.
 *
 * - Removes scripts/embeds that have no meaning on e-ink.
 * - HTTP <img> src URLs are collected into imageUrls and replaced with
 *   %%img-N%% placeholder tokens for the caller to resolve and embed.
 *   Images with no usable src fall back to an italic alt-text caption.
 * - Re-serialises via XMLSerializer so the output is valid XHTML.
 */
export function sanitizeArticleHtml(html: string): SanitizeResult {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`);
  const { document, XMLSerializer } = dom.window;

  for (const tag of STRIP_TAGS) {
    document.querySelectorAll(tag).forEach((el) => el.remove());
  }

  const imageUrls: string[] = [];
  document.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') ?? '';
    const alt = (img.getAttribute('alt') ?? '').trim();
    if (src.startsWith('http://') || src.startsWith('https://')) {
      img.setAttribute('src', `%%img-${imageUrls.length}%%`);
      imageUrls.push(src);
    } else if (alt) {
      const em = document.createElement('em');
      em.textContent = `[image: ${alt}]`;
      img.replaceWith(em);
    } else {
      img.remove();
    }
  });

  // Drop event-handler / style / class attributes.
  document.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) {
      if (attr.name.startsWith('on') || attr.name === 'style' || attr.name === 'class') {
        el.removeAttribute(attr.name);
      }
    }
  });

  // ADE/Kindle compatibility fixes.
  // <center> → <div style="text-align:center">
  document.querySelectorAll('center').forEach((el) => {
    const div = document.createElement('div');
    div.setAttribute('style', 'text-align:center');
    while (el.firstChild) div.appendChild(el.firstChild);
    el.replaceWith(div);
  });
  // <br> as direct child of <body> → <p> (prevents layout issues on Kindle)
  document.querySelectorAll('body > br').forEach((br) => {
    const p = document.createElement('p');
    p.setAttribute('style', 'margin:0');
    br.replaceWith(p);
  });
  // Strip zero-width spaces and soft hyphens from text nodes.
  const walker = document.createTreeWalker(document.body, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const cleaned = node.textContent!.replace(/[​­]/g, '');
    if (cleaned !== node.textContent) node.textContent = cleaned;
  }

  const serializer = new XMLSerializer();
  const xhtml = [...document.body.childNodes]
    .map((n) => serializer.serializeToString(n))
    .join('')
    .trim();

  return { xhtml, imageUrls };
}
