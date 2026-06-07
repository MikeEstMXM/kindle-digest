import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { escapeHtml } from '../util/html.js';
import type { FailureReason } from './fulltext.js';

export interface ExtractionResult {
  html: string;
  failureReason: FailureReason;
}

export type PageFetcher = (url: string) => Promise<{ status: number; body: string }>;

/** Default page fetcher using global fetch with a browser-like UA + timeout. */
export const defaultPageFetcher: PageFetcher = async (url) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: controller.signal,
    });
    return { status: res.status, body: await res.text() };
  } finally {
    clearTimeout(timeout);
  }
};

/** Build the inline error notice embedded when extraction fails. Never empty. */
export function inlineErrorNotice(url: string, reason: Exclude<FailureReason, null>): string {
  const labels: Record<Exclude<FailureReason, null>, string> = {
    paywall: 'This article appears to be behind a paywall, so its full text could not be retrieved.',
    'js-rendered':
      'This article is rendered by JavaScript and its full text could not be extracted server-side.',
    'http-error': 'The original page could not be fetched (HTTP error).',
  };
  return (
    `<div class="extract-error" role="note">` +
    `<p><strong>⚠ Full text unavailable.</strong> ${escapeHtml(labels[reason])}</p>` +
    `<p>Open the original via the QR code below: <span class="src-url">${escapeHtml(url)}</span></p>` +
    `</div>`
  );
}

const PAYWALL_HINTS = [
  'subscribe to continue',
  'subscribe to read',
  'create a free account',
  'this content is for subscribers',
  'become a member to',
];

/**
 * Fetch and extract an article's full text using Mozilla Readability.
 * Never throws and never truncates: on failure it returns a classified inline
 * error notice so the article is still included in the digest.
 */
export async function extractFullText(
  url: string,
  fetchPage: PageFetcher = defaultPageFetcher,
): Promise<ExtractionResult> {
  let page: { status: number; body: string };
  try {
    page = await fetchPage(url);
  } catch {
    return { html: inlineErrorNotice(url, 'http-error'), failureReason: 'http-error' };
  }

  if (page.status >= 400) {
    return { html: inlineErrorNotice(url, 'http-error'), failureReason: 'http-error' };
  }

  let article: { content: string | null; textContent: string | null } | null = null;
  try {
    const dom = new JSDOM(page.body, { url });
    article = new Readability(dom.window.document).parse();
  } catch {
    article = null;
  }

  const text = article?.textContent?.trim() ?? '';
  const content = article?.content?.trim() ?? '';

  // No usable content extracted. Classify why.
  if (!content || text.length < 200) {
    const lower = page.body.toLowerCase();
    if (PAYWALL_HINTS.some((h) => lower.includes(h))) {
      return { html: inlineErrorNotice(url, 'paywall'), failureReason: 'paywall' };
    }
    // Body present but Readability found ~nothing → almost certainly JS-rendered.
    return { html: inlineErrorNotice(url, 'js-rendered'), failureReason: 'js-rendered' };
  }

  return { html: content, failureReason: null };
}
