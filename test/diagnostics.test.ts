import { describe, it, expect } from 'vitest';
import { buildDiagnosticsPage } from '../src/diagnostics/build.js';

describe('buildDiagnosticsPage', () => {
  const page = buildDiagnosticsPage({
    folder: 'Technology',
    generatedAt: '2026-06-07 06:30:00 EDT',
    totalFetched: 5,
    included: 3,
    excluded: 2,
    totalGenerationMs: 4200,
    articles: [
      { title: 'A', contentSource: 'feed', failureReason: null },
      { title: 'B', contentSource: 'readability', failureReason: null },
      { title: 'C', contentSource: 'readability', failureReason: 'paywall' },
    ],
  });

  it('reports timestamp, counts and total generation time', () => {
    expect(page).toContain('2026-06-07 06:30:00 EDT');
    expect(page).toContain('Total articles fetched</dt><dd>5');
    expect(page).toContain('3 included, 2 excluded');
    expect(page).toContain('4.2s');
  });

  it('attributes per-article content source accurately', () => {
    expect(page).toContain('RSS feed');
    expect(page).toContain('Readability.js fallback');
  });

  it('lists extraction failures with their reason', () => {
    expect(page).toContain('Extraction failures (1)');
    expect(page).toMatch(/C — Paywall/);
  });

  it('says so when there are no failures', () => {
    const clean = buildDiagnosticsPage({
      folder: 'X',
      generatedAt: 'now',
      totalFetched: 1,
      included: 1,
      excluded: 0,
      totalGenerationMs: 100,
      articles: [{ title: 'A', contentSource: 'feed', failureReason: null }],
    });
    expect(clean).toContain('No extraction failures.');
  });
});
