import { describe, it, expect } from 'vitest';
import { extractFullText, inlineErrorNotice } from '../src/content/extract.js';

const ARTICLE_HTML = `<!DOCTYPE html><html><head><title>Real Article</title></head>
<body><article><h1>Real Article</h1>
${'<p>This is a substantial paragraph of real article content that Readability should happily extract and return as the main body text. </p>'.repeat(
  8,
)}
</article></body></html>`;

describe('extractFullText', () => {
  it('extracts full text via Readability on success (source body, no failure)', async () => {
    const res = await extractFullText('https://example.com/a', async () => ({
      status: 200,
      body: ARTICLE_HTML,
    }));
    expect(res.failureReason).toBeNull();
    expect(res.html.toLowerCase()).toContain('substantial paragraph');
    expect(res.html).not.toContain('Full text unavailable');
  });

  it('flags HTTP errors and still returns an inline notice (never empty)', async () => {
    const res = await extractFullText('https://example.com/404', async () => ({
      status: 404,
      body: 'Not found',
    }));
    expect(res.failureReason).toBe('http-error');
    expect(res.html).toContain('Full text unavailable');
    expect(res.html).toContain('HTTP error');
  });

  it('flags network failures as http-error', async () => {
    const res = await extractFullText('https://example.com/x', async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(res.failureReason).toBe('http-error');
    expect(res.html).toContain('Full text unavailable');
  });

  it('detects paywalls', async () => {
    const res = await extractFullText('https://paywall.com/x', async () => ({
      status: 200,
      body: '<html><body><div>Subscribe to continue reading this story.</div></body></html>',
    }));
    expect(res.failureReason).toBe('paywall');
    expect(res.html).toContain('paywall');
  });

  it('classifies empty/JS-rendered pages', async () => {
    const res = await extractFullText('https://spa.com/x', async () => ({
      status: 200,
      body: '<html><body><div id="root"></div></body></html>',
    }));
    expect(res.failureReason).toBe('js-rendered');
    expect(res.html).toContain('Full text unavailable');
  });

  it('never truncates: error notices are explicit, not excerpts', () => {
    const notice = inlineErrorNotice('https://example.com/x', 'paywall');
    expect(notice).toContain('Full text unavailable');
    expect(notice).toContain('https://example.com/x');
  });
});
