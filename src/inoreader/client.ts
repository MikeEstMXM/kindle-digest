import { textLength } from '../util/html.js';
import type {
  InoreaderItem,
  NormalizedArticle,
  StreamContentsResponse,
  SubscriptionListResponse,
} from './types.js';

export const READ_STATE = 'user/-/state/com.google/read';
const DEFAULT_BASE = 'https://www.inoreader.com';

export type FetchFn = typeof fetch;
export type AccessTokenProvider = () => Promise<string>;

export interface InoreaderClientOptions {
  getAccessToken: AccessTokenProvider;
  baseUrl?: string;
  fetchFn?: FetchFn;
  /** Max items to pull per folder (safety bound across pagination). */
  maxItemsPerFolder?: number;
}

/** Pick the best canonical URL for an item. */
export function pickUrl(item: InoreaderItem): string {
  if (item.canonical?.[0]?.href) return item.canonical[0].href;
  const html = item.alternate?.find((a) => !a.type || a.type === 'text/html');
  if (html?.href) return html.href;
  return item.alternate?.[0]?.href ?? item.origin?.htmlUrl ?? '';
}

export function normalizeItem(item: InoreaderItem): NormalizedArticle {
  const html = item.content?.content ?? item.summary?.content ?? '';
  return {
    itemId: item.id,
    title: item.title ?? '(untitled)',
    url: pickUrl(item),
    author: item.author || undefined,
    publishedMs: item.published ? item.published * 1000 : undefined,
    feedTitle: item.origin?.title ?? 'Unknown feed',
    feedUrl: item.origin?.htmlUrl,
    inoreaderHtml: html,
    inoreaderTextLength: textLength(html),
  };
}

export class InoreaderClient {
  private base: string;
  private fetchFn: FetchFn;
  private getAccessToken: AccessTokenProvider;
  private maxItems: number;

  constructor(opts: InoreaderClientOptions) {
    this.base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
    this.fetchFn = opts.fetchFn ?? fetch;
    this.getAccessToken = opts.getAccessToken;
    this.maxItems = opts.maxItemsPerFolder ?? 200;
  }

  private async authedFetch(path: string, init?: RequestInit): Promise<Response> {
    const token = await this.getAccessToken();
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${token}`);
    const res = await this.fetchFn(`${this.base}${path}`, { ...init, headers });
    if (!res.ok) {
      throw new Error(`Inoreader API ${path} failed: ${res.status} ${await res.text()}`);
    }
    return res;
  }

  /** Distinct top-level folder names, derived from subscription categories. */
  async getFolders(): Promise<string[]> {
    const res = await this.authedFetch('/reader/api/0/subscription/list?output=json');
    const data = (await res.json()) as SubscriptionListResponse;
    const folders = new Set<string>();
    for (const sub of data.subscriptions ?? []) {
      for (const cat of sub.categories ?? []) {
        if (cat.label) folders.add(cat.label);
      }
    }
    return [...folders].sort((a, b) => a.localeCompare(b));
  }

  /**
   * Unread articles for a single top-level folder, normalised and paginated.
   * Excludes already-read items via the `xt` parameter.
   */
  async getUnreadByFolder(folder: string): Promise<NormalizedArticle[]> {
    const streamId = `user/-/label/${folder}`;
    const out: NormalizedArticle[] = [];
    let continuation: string | undefined;
    do {
      const params = new URLSearchParams({
        xt: READ_STATE,
        n: '50',
        output: 'json',
      });
      if (continuation) params.set('c', continuation);
      const res = await this.authedFetch(
        `/reader/api/0/stream/contents/${encodeURIComponent(streamId)}?${params.toString()}`,
      );
      const data = (await res.json()) as StreamContentsResponse;
      for (const item of data.items ?? []) {
        out.push(normalizeItem(item));
        if (out.length >= this.maxItems) return out;
      }
      continuation = data.continuation;
    } while (continuation);
    return out;
  }

  /** Mark items as read in Inoreader (batched). */
  async markRead(itemIds: string[]): Promise<void> {
    if (itemIds.length === 0) return;
    const BATCH = 50;
    for (let i = 0; i < itemIds.length; i += BATCH) {
      const batch = itemIds.slice(i, i + BATCH);
      const body = new URLSearchParams();
      body.set('a', READ_STATE);
      for (const id of batch) body.append('i', id);
      await this.authedFetch('/reader/api/0/edit-tag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    }
  }
}
