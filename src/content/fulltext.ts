import type { NormalizedArticle } from '../reader/types.js';

export type ContentSource = 'feed' | 'readability';
export type FailureReason = 'paywall' | 'js-rendered' | 'http-error' | null;

export interface ResolvedContent {
  source: ContentSource;
  /** Article body HTML to embed (full text, or an inline error notice). */
  html: string;
  failureReason: FailureReason;
  extractMs: number;
}

/**
 * Decide whether the reader's own content is "full enough" to use directly.
 * Heuristic: the extracted visible-text length must meet a threshold. When it
 * does, we avoid an extra page fetch; otherwise the caller triggers the
 * Readability fallback.
 */
export function contentIsFull(
  article: Pick<NormalizedArticle, 'contentTextLength'>,
  minChars: number,
): boolean {
  return article.contentTextLength >= minChars;
}
