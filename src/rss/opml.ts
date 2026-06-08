import { JSDOM } from 'jsdom';

export interface OpmlFeed {
  url: string;
  title: string;
  folder: string;
}

/**
 * Parse an OPML file and return a flat list of feeds with their folder
 * assignments. Top-level outlines without an xmlUrl become folders; their
 * children become feeds. Root-level feed outlines go to "Uncategorized".
 * Handles both camelCase (xmlUrl) and lowercase (xmlurl) attribute variants.
 */
export function parseOpml(xml: string): OpmlFeed[] {
  const dom = new JSDOM(xml, { contentType: 'text/xml' });
  const doc = dom.window.document;
  const results: OpmlFeed[] = [];

  function xmlUrl(el: Element): string {
    return el.getAttribute('xmlUrl') ?? el.getAttribute('xmlurl') ?? '';
  }

  function processOutline(el: Element, folder: string): void {
    const url = xmlUrl(el);
    if (url) {
      results.push({
        url,
        title: el.getAttribute('title') ?? el.getAttribute('text') ?? url,
        folder,
      });
    } else {
      const name = el.getAttribute('title') ?? el.getAttribute('text') ?? folder;
      for (const child of el.children) {
        if (child.tagName.toLowerCase() === 'outline') {
          processOutline(child, name);
        }
      }
    }
  }

  const body = doc.querySelector('body');
  if (!body) return results;

  for (const child of body.children) {
    if (child.tagName.toLowerCase() === 'outline') {
      processOutline(child, 'Uncategorized');
    }
  }

  return results;
}
