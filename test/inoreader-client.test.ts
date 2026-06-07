import { describe, it, expect, vi } from 'vitest';
import { InoreaderClient, normalizeItem, pickUrl, READ_STATE } from '../src/inoreader/client.js';
import { inoreaderContentIsFull } from '../src/content/fulltext.js';
import type { InoreaderItem } from '../src/inoreader/types.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function makeItem(over: Partial<InoreaderItem> = {}): InoreaderItem {
  return {
    id: 'tag:google.com,2005:reader/item/0001',
    title: 'Hello',
    published: 1700000000,
    canonical: [{ href: 'https://example.com/a' }],
    summary: { content: '<p>short</p>' },
    origin: { title: 'Example Feed', htmlUrl: 'https://example.com' },
    ...over,
  };
}

describe('inoreader normalisation', () => {
  it('prefers canonical url then alternate then origin', () => {
    expect(pickUrl(makeItem())).toBe('https://example.com/a');
    expect(
      pickUrl(makeItem({ canonical: undefined, alternate: [{ href: 'https://alt/x' }] })),
    ).toBe('https://alt/x');
    expect(
      pickUrl(makeItem({ canonical: undefined, alternate: undefined })),
    ).toBe('https://example.com');
  });

  it('computes inoreader text length for full-text detection', () => {
    const longHtml = `<p>${'word '.repeat(500)}</p>`;
    const n = normalizeItem(makeItem({ content: { content: longHtml }, summary: undefined }));
    expect(n.inoreaderTextLength).toBeGreaterThan(2000);
    expect(inoreaderContentIsFull(n, 1800)).toBe(true);

    const short = normalizeItem(makeItem());
    expect(inoreaderContentIsFull(short, 1800)).toBe(false);
  });
});

describe('InoreaderClient', () => {
  const getAccessToken = async () => 'TOKEN';

  it('derives distinct top-level folders from subscriptions', async () => {
    const fetchSpy = vi.fn(async (_url?: unknown, _init?: unknown) =>
      jsonResponse({
        subscriptions: [
          { id: 'feed/1', title: 'A', categories: [{ id: 'user/1/label/Tech', label: 'Tech' }] },
          { id: 'feed/2', title: 'B', categories: [{ id: 'user/1/label/News', label: 'News' }] },
          { id: 'feed/3', title: 'C', categories: [{ id: 'user/1/label/Tech', label: 'Tech' }] },
        ],
      }),
    );

    const client = new InoreaderClient({
      getAccessToken,
      fetchFn: fetchSpy as unknown as typeof fetch,
    });
    const folders = await client.getFolders();
    expect(folders).toEqual(['News', 'Tech']);
    // Authorization header is attached.
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer TOKEN');
  });

  it('paginates unread items and excludes read via xt', async () => {
    const calls: string[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes('c=CONT')) {
        return jsonResponse({ items: [makeItem({ id: 'i2' })] });
      }
      return jsonResponse({ items: [makeItem({ id: 'i1' })], continuation: 'CONT' });
    }) as unknown as typeof fetch;

    const client = new InoreaderClient({ getAccessToken, fetchFn });
    const articles = await client.getUnreadByFolder('Tech');
    expect(articles.map((a) => a.itemId)).toEqual(['i1', 'i2']);
    expect(calls[0]).toContain(`xt=${encodeURIComponent(READ_STATE)}`);
    expect(calls[0]).toContain(encodeURIComponent('user/-/label/Tech'));
    expect(calls[1]).toContain('c=CONT');
  });

  it('marks items read with batched edit-tag payloads', async () => {
    const bodies: string[] = [];
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response('OK', { status: 200 });
    }) as unknown as typeof fetch;

    const client = new InoreaderClient({ getAccessToken, fetchFn });
    const ids = Array.from({ length: 60 }, (_, i) => `id-${i}`);
    await client.markRead(ids);
    expect(bodies.length).toBe(2); // 60 ids in batches of 50
    expect(bodies[0]).toContain(`a=${encodeURIComponent(READ_STATE)}`);
    expect(bodies[0]).toContain('i=id-0');
  });

  it('throws on API error responses', async () => {
    const fetchFn = vi.fn(async () => new Response('nope', { status: 403 })) as unknown as typeof fetch;
    const client = new InoreaderClient({ getAccessToken, fetchFn });
    await expect(client.getFolders()).rejects.toThrow(/403/);
  });
});
