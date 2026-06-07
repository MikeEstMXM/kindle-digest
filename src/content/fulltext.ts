import type { NormalizedArticle } from '../inoreader/types.js';

export type ContentSource = 'inoreader' | 'readability';
export type FailureReason = 'paywall' | 'js-rendered' | 'http-error' | null;

export interface ResolvedContent {
  source: ContentSource;
  /** Article body HTML to embed (full text, or an inline error notice). */
  html: string;
  failureReason: FailureReason;
  extractMs: number;
}

/**
 * Decide whether Inoreader's own content is "full enough" to use directly.
 * Heuristic: the extracted visible-text length must meet a threshold. When it
 * does, we avoid an extra page fetch; otherwise the caller triggers the
 * Readability fallback. This is the single decision point the tests assert on.
 */
export function inoreaderContentIsFull(
  article: Pick<NormalizedArticle, 'inoreaderTextLength'>,
  minChars: number,
): boolean {
  return article.inoreaderTextLength >= minChars;
}
