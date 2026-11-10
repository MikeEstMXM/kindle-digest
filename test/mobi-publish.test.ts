import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishIssue, pruneIssues, ISSUE_FILE } from '../src/mobi/publish.js';
import { issueSlug } from '../src/util/folderName.js';
import { loadEnv, resetEnvCache } from '../src/config/env.js';
import { readMobiExth, periodicalProblems } from '../src/mobi/exth.js';
import { PermanentConversionError } from '../src/mobi/convert.js';
import { publishBuiltDigest } from '../src/digest/service.js';
import { makeApp, testEnv } from './helpers/app.js';
import { fixtureEpub } from './helpers/fixtureEpub.js';

const BIN = process.env.EBOOK_CONVERT_BIN ?? 'ebook-convert';
const hasCalibre = spawnSync(BIN, ['--version'], { stdio: 'ignore' }).status === 0;

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kd-mobi-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

// Needs calibre's ebook-convert on PATH (it is in the Docker image). Skips
// cleanly everywhere else rather than failing a laptop run.
describe.skipIf(!hasCalibre)('periodical conversion (real ebook-convert)', () => {
  it('produces an NWPR periodical with a cover, no ASIN, and the folder as title', async () => {
    const epub = join(dir, 'in.epub');
    await fixtureEpub(epub, 'Technology');
    const kindleDir = join(dir, 'kindle');

    const out = await publishIssue({
      epubPath: epub,
      folder: 'Technology',
      isoDate: '2026-11-10',
      kindleDir,
      keepIssues: 7,
      ebookConvertBin: BIN,
      timeoutMs: 5 * 60 * 1000,
    });

    expect(out.mobiPath).toBe(join(kindleDir, 'technology', 'technology-2026-11-10.mobi'));
    const exth = await readMobiExth(out.mobiPath);
    expect(exth.cdeType).toBe('NWPR');
    expect(exth.hasAsin).toBe(false);
    expect(exth.hasCover).toBe(true);
    expect(exth.updatedTitle).toBe('Technology');
    expect(periodicalProblems(exth)).toEqual([]);

    // Nothing but the finished issue is left behind (work dir is dot-prefixed and emptied).
    expect(await readdir(join(kindleDir, 'technology'))).toEqual(['technology-2026-11-10.mobi']);
    expect(await readdir(join(kindleDir, '.work'))).toEqual([]);
  }, 300_000);

  it('keeps every issue when no limit is set, and prunes only when one is', async () => {
    const epub = join(dir, 'keep.epub');
    await fixtureEpub(epub, 'Retain');
    const kindleDir = join(dir, 'kindle-keep');
    const folderDir = join(kindleDir, 'retain');
    await mkdir(folderDir, { recursive: true });
    for (let d = 1; d <= 10; d++) {
      await writeFile(join(folderDir, `retain-2026-10-${String(d).padStart(2, '0')}.mobi`), 'old');
    }
    const base = { epubPath: epub, folder: 'Retain', kindleDir, ebookConvertBin: BIN, timeoutMs: 5 * 60 * 1000 };

    const all = await publishIssue({ ...base, isoDate: '2026-11-10', keepIssues: 0 });
    expect(all.pruned).toEqual([]);
    expect(await readdir(folderDir)).toHaveLength(11);

    const some = await publishIssue({ ...base, isoDate: '2026-11-11', keepIssues: 3 });
    expect(some.pruned).toHaveLength(9);
    expect((await readdir(folderDir)).sort()).toEqual([
      'retain-2026-11-10.mobi',
      'retain-2026-11-11.mobi',
      'retain-2026-10-10.mobi',
    ].sort());
  }, 300_000);

  it('publishing adds the issue to the archive index, and retention removes pruned ones from it', async () => {
    const epub = join(dir, 'index.epub');
    await fixtureEpub(epub, 'Indexed');
    const t = makeApp(testEnv({ kindleDir: join(dir, 'kindle-index'), ebookConvertBin: BIN, convertTimeoutMs: 5 * 60 * 1000 }));
    await publishBuiltDigest(t.ctx, 'Indexed', '2026-11-09', epub);
    await publishBuiltDigest(t.ctx, 'Indexed', '2026-11-10', epub);
    expect(t.ctx.issues.list('indexed').map((i) => i.issueDate)).toEqual(['2026-11-10', '2026-11-09']);
    expect(t.ctx.issues.folders()[0]).toMatchObject({ folder: 'Indexed', count: 2 });

    t.ctx.env.kindleKeepIssues = 1;
    await publishBuiltDigest(t.ctx, 'Indexed', '2026-11-11', epub);
    expect(t.ctx.issues.list('indexed').map((i) => i.issueDate)).toEqual(['2026-11-11']);
    await t.app.close();
  }, 300_000);

  it('rejects an EPUB without a cover instead of publishing a coverless issue', async () => {
    const epub = join(dir, 'nocover.epub');
    await fixtureEpub(epub, 'Broken');
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(await (await import('node:fs/promises')).readFile(epub));
    const opf = await zip.file('OEBPS/content.opf')!.async('string');
    zip.file('OEBPS/content.opf', opf.replace(' properties="cover-image"', ''));
    await writeFile(epub, await zip.generateAsync({ type: 'nodebuffer' }));

    await expect(
      publishIssue({
        epubPath: epub,
        folder: 'Broken',
        isoDate: '2026-11-10',
        kindleDir: join(dir, 'kindle'),
        keepIssues: 7,
        ebookConvertBin: BIN,
        timeoutMs: 60_000,
      }),
    ).rejects.toBeInstanceOf(PermanentConversionError);
  });
});

describe('failure handling (no calibre needed)', () => {
  it('a missing converter is a clear, permanent error', async () => {
    const epub = join(dir, 'in2.epub');
    await fixtureEpub(epub, 'News');
    const err = await publishIssue({
      epubPath: epub,
      folder: 'News',
      isoDate: '2026-11-10',
      kindleDir: join(dir, 'kindle2'),
      keepIssues: 7,
      ebookConvertBin: '/nonexistent/ebook-convert',
      timeoutMs: 10_000,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentConversionError);
    expect((err as Error).message).toMatch(/ebook-convert not found/);
    // A failed conversion publishes nothing.
    expect(await readdir(join(dir, 'kindle2', 'news'))).toEqual([]);
  });

  it('a converter that fails reports its output', async () => {
    const epub = join(dir, 'in3.epub');
    await fixtureEpub(epub, 'News');
    const fake = join(dir, 'fail.sh');
    await writeFile(fake, '#!/bin/sh\necho "boom: cannot convert" >&2\nexit 3\n', { mode: 0o755 });
    const err = await publishIssue({
      epubPath: epub,
      folder: 'News',
      isoDate: '2026-11-10',
      kindleDir: join(dir, 'kindle3'),
      keepIssues: 7,
      ebookConvertBin: fake,
      timeoutMs: 10_000,
    }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/exit code 3/);
    expect((err as Error).message).toMatch(/boom: cannot convert/);
    expect(err).not.toBeInstanceOf(PermanentConversionError); // worth a retry
  });

  it('kills a converter that overruns the timeout', async () => {
    const epub = join(dir, 'in4.epub');
    await fixtureEpub(epub, 'News');
    const fake = join(dir, 'hang.sh');
    await writeFile(fake, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    const err = await publishIssue({
      epubPath: epub,
      folder: 'News',
      isoDate: '2026-11-10',
      kindleDir: join(dir, 'kindle4'),
      keepIssues: 7,
      ebookConvertBin: fake,
      timeoutMs: 300,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentConversionError);
    expect((err as Error).message).toMatch(/timed out/);
  });
});

describe('pruneIssues', () => {
  it('keeps the newest N issues of the folder and nothing else is touched', async () => {
    const d = join(dir, 'prune', 'news');
    await mkdir(d, { recursive: true });
    for (const day of ['01', '02', '03', '04', '05']) {
      await writeFile(join(d, `news-2026-11-${day}.mobi`), 'x');
    }
    await writeFile(join(d, 'notes.txt'), 'keep me');

    const removed = await pruneIssues(d, 'news', 3);

    expect(removed.sort()).toEqual(['news-2026-11-01.mobi', 'news-2026-11-02.mobi']);
    expect((await readdir(d)).sort()).toEqual([
      'news-2026-11-03.mobi',
      'news-2026-11-04.mobi',
      'news-2026-11-05.mobi',
      'notes.txt',
    ]);
  });

  it('never prunes below one issue, whatever the setting', async () => {
    const d = join(dir, 'prune2', 'tech');
    await mkdir(d, { recursive: true });
    await writeFile(join(d, 'tech-2026-11-01.mobi'), 'x');
    await pruneIssues(d, 'tech', 0);
    expect(await readdir(d)).toEqual(['tech-2026-11-01.mobi']);
  });

  it('a garbage keep value (NaN) deletes nothing instead of everything', async () => {
    const d = join(dir, 'prune3', 'tech');
    await mkdir(d, { recursive: true });
    for (const day of ['01', '02', '03']) await writeFile(join(d, `tech-2026-11-${day}.mobi`), 'x');
    expect(await pruneIssues(d, 'tech', Number.NaN)).toEqual([]);
  });

  it('never deletes the issue just published, even when it is the oldest', async () => {
    const d = join(dir, 'prune4', 'tech');
    await mkdir(d, { recursive: true });
    for (const day of ['05', '06', '07']) await writeFile(join(d, `tech-2026-11-${day}.mobi`), 'x');
    await writeFile(join(d, 'tech-2026-10-01.mobi'), 'x'); // a re-run of an old date
    const removed = await pruneIssues(d, 'tech', 2, 'tech-2026-10-01.mobi');
    expect(removed).toEqual(['tech-2026-11-05.mobi']);
    expect(await readdir(d)).toContain('tech-2026-10-01.mobi');
  });
});

describe('issueSlug', () => {
  it('leaves ordinary names alone', () => {
    expect(issueSlug('News')).toBe('news');
    expect(issueSlug('Tech & AI')).toBe('tech-ai');
  });

  it('keeps lossy names apart with a hash, and stays inside the filename pattern', () => {
    const a = issueSlug('日本');
    const b = issueSlug('中国');
    expect(a).not.toBe(b);
    for (const s of [a, b, issueSlug('!!!'), issueSlug('x'.repeat(200))]) {
      expect(`${s}-2026-11-10.mobi`).toMatch(ISSUE_FILE);
      expect(s.length).toBeLessThanOrEqual(70);
    }
  });
});

describe('env validation', () => {
  it('falls back to defaults for typos instead of NaN', async () => {
    process.env.KINDLE_KEEP_ISSUES = 'abc';
    process.env.CONVERT_TIMEOUT_MS = '-5';
    resetEnvCache();
    const env = loadEnv();
    expect(env.kindleKeepIssues).toBe(0); // a typo means "keep everything", never "delete"
    expect(env.convertTimeoutMs).toBe(20 * 60 * 1000);
    delete process.env.KINDLE_KEEP_ISSUES;
    delete process.env.CONVERT_TIMEOUT_MS;
    resetEnvCache();
    expect(loadEnv().kindleKeepIssues).toBe(0); // unset keeps every issue
    process.env.KINDLE_KEEP_ISSUES = '3';
    resetEnvCache();
    expect(loadEnv().kindleKeepIssues).toBe(3);
    delete process.env.KINDLE_KEEP_ISSUES;
    resetEnvCache();
  });
});
