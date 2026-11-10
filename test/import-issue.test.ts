import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import { buildArticlePage } from '../src/epub/article.js';
import { openDb, type DB } from '../src/db/schema.js';
import { IssueRepo } from '../src/db/issueRepo.js';
import { periodicalProblems, readMobiExth } from '../src/mobi/exth.js';
import { buildEpubFromStaging, classifyDir, ImportSourceError, zipEpubDir } from '../src/import/staging.js';
import { importIssue, isIsoDate } from '../src/import/importIssue.js';
import { runCli, type CliDeps } from '../src/import/cli.js';
import { fixtureEpub } from './helpers/fixtureEpub.js';

const BIN = process.env.EBOOK_CONVERT_BIN ?? 'ebook-convert';
const hasCalibre = spawnSync(BIN, ['--version'], { stdio: 'ignore' }).status === 0;

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kd-import-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * A build staging directory as an interrupted digest build leaves it: article
 * pages and `images_*` files, nothing else. Deliberately imperfect, like the
 * real one: art-3 was never staged, and art-4 points at a picture that is not there.
 */
async function stagingDir(name: string): Promise<string> {
  const d = join(dir, name);
  await mkdir(d, { recursive: true });
  const jpeg = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#778899' } })
    .jpeg()
    .toBuffer();
  const png = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#000' } }).png().toBuffer();
  const page = (n: number, feed: string, feedIdx: number, prev: number | null, next: number | null, img = false) =>
    buildArticlePage({
      title: `Article ${n} & more`,
      url: `https://example.com/${n}`,
      feedTitle: feed,
      author: 'Someone',
      dateLabel: 'November 2, 2026',
      bodyXhtml: `<div><p>${'Body text. '.repeat(40)}</p>${img ? `<img src="images/art-${n}-img-0.jpg" alt=""/>` : ''}</div>`,
      qrHref: `images/qr-${n}.png`,
      navBar: {
        prevHref: prev ? `art-${prev}.xhtml` : null,
        nextHref: next ? `art-${next}.xhtml` : null,
        sectionHref: `feed-${feedIdx}-index.xhtml`,
      },
    });
  await writeFile(join(d, 'art-1.xhtml'), page(1, 'Feed A', 0, null, 2, true));
  await writeFile(join(d, 'art-2.xhtml'), page(2, 'Feed A', 0, 1, 3));
  await writeFile(join(d, 'art-4.xhtml'), page(4, 'Feed B', 1, null, null, true));
  await writeFile(join(d, 'images_art-1-img-0.jpg'), jpeg);
  for (const n of [1, 2, 4]) await writeFile(join(d, `images_qr-${n}.png`), png);
  return d;
}

describe('building an EPUB from a staging directory', () => {
  it('rebuilds navigation, cover and sections, and repairs what is missing', async () => {
    const src = await stagingDir('staging-a');
    const out = join(dir, 'staged.epub');
    const result = await buildEpubFromStaging(src, out, {
      folder: 'News',
      isoDate: '2026-11-01',
      scratchDir: dir,
    });
    expect(result).toEqual({ articles: 3, missingArticles: [3], droppedImages: 1 });

    // `mimetype` first and stored: the first local header says method 0 and names it.
    const raw = await readFile(out);
    expect(raw.readUInt16LE(8)).toBe(0);
    expect(raw.subarray(30, 38).toString()).toBe('mimetype');

    const zip = await JSZip.loadAsync(raw);
    const opf = await zip.file('OEBPS/content.opf')!.async('string');
    expect(opf).toContain('art-1.xhtml');
    expect(opf).toContain('art-4.xhtml');
    expect(opf).not.toContain('art-3.xhtml');
    expect(opf).toContain('2026-11-01');
    expect(opf).toMatch(/properties="cover-image"/);
    expect(Object.keys(zip.files)).toEqual(
      expect.arrayContaining([
        'OEBPS/toc.ncx',
        'OEBPS/toc.xhtml',
        'OEBPS/feed-0-index.xhtml',
        'OEBPS/feed-1-index.xhtml',
        'OEBPS/images/cover.jpg',
        'OEBPS/images/masthead.jpg',
        'OEBPS/images/art-1-img-0.jpg',
        'OEBPS/images/qr-4.png',
      ]),
    );
    const toc = await zip.file('OEBPS/toc.xhtml')!.async('string');
    expect(toc).toContain('Feed A');
    expect(toc).toContain('Article 4 &amp; more');
    // No dangling references: the missing picture and the link to art-3 are gone.
    expect(await zip.file('OEBPS/art-4.xhtml')!.async('string')).not.toContain('art-4-img-0.jpg');
    const two = await zip.file('OEBPS/art-2.xhtml')!.async('string');
    expect(two).not.toContain('art-3.xhtml');
    expect(two).toContain('nav-disabled">Next');
    // A page that needed no repair is carried over unchanged.
    expect(await zip.file('OEBPS/art-1.xhtml')!.async('string')).toBe(await readFile(join(src, 'art-1.xhtml'), 'utf8'));
  });

  it('refuses directories that are not article pages', async () => {
    const empty = join(dir, 'empty');
    await mkdir(empty, { recursive: true });
    await expect(classifyDir(empty)).rejects.toBeInstanceOf(ImportSourceError);
    expect(await classifyDir(await stagingDir('staging-b'))).toBe('staging');
  });

  it('zips an unpacked EPUB with mimetype first and stored', async () => {
    const epub = join(dir, 'whole.epub');
    await fixtureEpub(epub, 'Money');
    const unpacked = join(dir, 'unpacked');
    const zip = await JSZip.loadAsync(await readFile(epub));
    for (const [name, file] of Object.entries(zip.files)) {
      if (file.dir) await mkdir(join(unpacked, name), { recursive: true });
      else {
        await mkdir(join(unpacked, name, '..'), { recursive: true });
        await writeFile(join(unpacked, name), await file.async('nodebuffer'));
      }
    }
    expect(await classifyDir(unpacked)).toBe('epub');
    const out = join(dir, 'rezipped.epub');
    await zipEpubDir(unpacked, out);
    const raw = await readFile(out);
    expect(raw.readUInt16LE(8)).toBe(0);
    expect(raw.subarray(30, 38).toString()).toBe('mimetype');
    const again = await JSZip.loadAsync(raw);
    expect(Object.keys(again.files).sort()).toEqual(Object.keys(zip.files).sort());
  });
});

describe('dates', () => {
  it('accepts real ISO dates only', () => {
    expect(isIsoDate('2026-11-02')).toBe(true);
    for (const bad of ['2026-02-30', '2026-1-2', 'yesterday', '', '2026-11-02T00:00']) {
      expect(isIsoDate(bad)).toBe(false);
    }
  });
});

describe('command line', () => {
  const noDeps = (issues: IssueRepo): CliDeps => ({
    kindleDir: join(dir, 'cli-none'),
    ebookConvertBin: BIN,
    timeoutMs: 5 * 60 * 1000,
    issues,
    knownFolders: ['Money', 'News'],
    coverSettings: () => ({ coverTemplate: null, coverTheme: 'dark' }),
    fonts: [],
  });
  const run = async (args: string[], deps: CliDeps): Promise<{ code: number; lines: string[] }> => {
    const lines: string[] = [];
    const code = await runCli(args, deps, (l) => lines.push(l));
    return { code, lines };
  };

  it('explains bad usage with exit code 2', async () => {
    const deps = noDeps(new IssueRepo(openDb(':memory:')));
    expect((await run([], deps)).code).toBe(2);
    expect((await run(['--folder', 'Money', 'x.epub'], deps)).code).toBe(2); // no date
    expect((await run(['--bogus'], deps)).code).toBe(2);
    expect((await run(['--dir', dir, '--folder', 'Money'], deps)).code).toBe(2);
    const help = await run(['--help'], deps);
    expect(help.code).toBe(0);
    expect(help.lines[0]).toContain('import-issue');
  });

  it('reports a bad date or a missing file as one failed line, not a crash', async () => {
    const deps = noDeps(new IssueRepo(openDb(':memory:')));
    const bad = await run(['--folder', 'Money', '--date', '2026-13-40', join(dir, 'x.epub')], deps);
    expect(bad.code).toBe(1);
    expect(bad.lines).toHaveLength(1);
    expect(bad.lines[0]).toMatch(/^failed .*not a date/);
    const gone = await run(['--folder', 'Money', '--date', '2026-11-02', join(dir, 'nope.epub')], deps);
    expect(gone.lines[0]).toMatch(/^failed .*does not exist/);
  });

  it('--dir ignores azw3 files and names unknown folders', async () => {
    const d = join(dir, 'batch-none');
    await mkdir(d, { recursive: true });
    await writeFile(join(d, 'news-2026-06-01.azw3'), 'x');
    await writeFile(join(d, 'poetry-2026-11-02.epub'), 'x');
    await writeFile(join(d, 'notes.epub'), 'x');
    const r = await run(['--dir', d], noDeps(new IssueRepo(openDb(':memory:'))));
    expect(r.code).toBe(1);
    expect(r.lines).toHaveLength(2);
    expect(r.lines.join('\n')).toMatch(/failed .*poetry-2026-11-02\.epub.*unknown folder "poetry"/);
    expect(r.lines.join('\n')).toMatch(/skipped .*notes\.epub/);
    expect(r.lines.join('\n')).not.toContain('azw3');
  });
});

// Needs calibre's ebook-convert (it is in the Docker image).
describe.skipIf(!hasCalibre)('importing past issues (real ebook-convert)', () => {
  const base = (db: DB, kindleDir: string) => ({
    kindleDir,
    issues: new IssueRepo(db),
    ebookConvertBin: BIN,
    timeoutMs: 5 * 60 * 1000,
  });
  const deliveryCount = (db: DB): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM delivery').get() as { n: number }).n;

  it('files an EPUB under its original date, indexes it, and leaves everything else alone', async () => {
    const db = openDb(':memory:');
    const kindleDir = join(dir, 'kindle-a');
    const folderDir = join(kindleDir, 'money');
    await mkdir(folderDir, { recursive: true });
    for (const d of ['2026-10-01', '2026-10-02']) await writeFile(join(folderDir, `money-${d}.mobi`), 'old');
    const deliveriesBefore = deliveryCount(db);

    const epub = join(dir, 'money-2026-11-02.epub');
    await fixtureEpub(epub, 'Money');
    const before = await readFile(epub);

    const r = await importIssue({ ...base(db, kindleDir), folder: 'Money', isoDate: '2026-11-02', source: epub, force: false });
    expect(r.status).toBe('imported');
    expect(r.fileName).toBe('money-2026-11-02.mobi');

    const exth = await readMobiExth(join(folderDir, 'money-2026-11-02.mobi'));
    expect(exth.cdeType).toBe('NWPR');
    expect(exth.hasAsin).toBe(false);
    expect(exth.hasCover).toBe(true);
    expect(periodicalProblems(exth)).toEqual([]);

    const row = new IssueRepo(db).find('money', 'money-2026-11-02.mobi');
    expect(row?.issueDate).toBe('2026-11-02');
    expect(row?.folder).toBe('Money');
    expect(row?.bytes).toBe(r.bytes);
    // Sorts by its own date, not by when it was imported.
    expect(new IssueRepo(db).list('money').map((i) => i.issueDate)).toEqual(['2026-11-02']);

    expect((await readdir(folderDir)).sort()).toEqual([
      'money-2026-10-01.mobi',
      'money-2026-10-02.mobi',
      'money-2026-11-02.mobi',
    ]);
    expect(deliveryCount(db)).toBe(deliveriesBefore);
    expect(await readFile(epub)).toEqual(before); // the source is untouched
    expect(await readdir(join(kindleDir, '.work'))).toEqual([]);
  }, 300_000);

  it('skips an issue that is already there unless --force', async () => {
    const db = openDb(':memory:');
    const kindleDir = join(dir, 'kindle-b');
    const epub = join(dir, 'again.epub');
    await fixtureEpub(epub, 'Science');
    const opts = { ...base(db, kindleDir), folder: 'Science', isoDate: '2026-11-01', source: epub };
    const path = join(kindleDir, 'science', 'science-2026-11-01.mobi');

    expect((await importIssue({ ...opts, force: false })).status).toBe('imported');
    const first = await stat(path);

    const second = await importIssue({ ...opts, force: false });
    expect(second.status).toBe('skipped');
    expect((await stat(path)).mtimeMs).toBe(first.mtimeMs);

    const third = await importIssue({ ...opts, force: true });
    expect(third.status).toBe('replaced');
    expect((await stat(path)).mtimeMs).toBeGreaterThan(first.mtimeMs);
    expect(new IssueRepo(db).list('science')).toHaveLength(1);
  }, 300_000);

  it('a failed conversion leaves no file and no index entry', async () => {
    const db = openDb(':memory:');
    const kindleDir = join(dir, 'kindle-c');
    const notEpub = join(dir, 'broken.epub');
    await writeFile(notEpub, 'not a zip');
    const r = await importIssue({
      ...base(db, kindleDir), folder: 'News', isoDate: '2026-11-08', source: notEpub, force: false,
    }).catch((e: unknown) => e);
    expect(r).toBeInstanceOf(Error);
    expect(new IssueRepo(db).all()).toEqual([]);
    expect(await readdir(join(kindleDir, 'news'))).toEqual([]);
  }, 120_000);

  it('rebuilds a staging directory into a periodical with the right date', async () => {
    const db = openDb(':memory:');
    const kindleDir = join(dir, 'kindle-d');
    const src = await stagingDir('staging-import');
    const r = await importIssue({ ...base(db, kindleDir), folder: 'News', isoDate: '2026-11-01', source: src, force: false });
    expect(r.status).toBe('imported');
    expect(r.note).toBe('rebuilt from staging: 3 articles, 1 missing pages, 1 missing images dropped');
    const exth = await readMobiExth(join(kindleDir, 'news', 'news-2026-11-01.mobi'));
    expect(periodicalProblems(exth)).toEqual([]);
    expect(exth.updatedTitle).toBe('News');
    expect(new IssueRepo(db).list('news')[0].issueDate).toBe('2026-11-01');
    expect(await readdir(src)).not.toContain('source.epub'); // the input dir is never written to
  }, 300_000);

  it('--dir imports every epub and staging dir, one line each, and a second run skips them', async () => {
    const db = openDb(':memory:');
    const kindleDir = join(dir, 'kindle-e');
    const d = join(dir, 'recovered');
    await mkdir(d, { recursive: true });
    await fixtureEpub(join(d, 'money-2026-11-02.epub'), 'Money');
    await copyFile(join(d, 'money-2026-11-02.epub'), join(d, 'money-2026-11-09.epub'));
    await writeFile(join(d, 'news-2026-06-01.azw3'), 'x');
    const staged = await stagingDir('staging-tmp');
    await rm(join(d, '.staging-news-2026-11-01'), { recursive: true, force: true });
    for (const f of await readdir(staged)) {
      await mkdir(join(d, '.staging-news-2026-11-01'), { recursive: true });
      await copyFile(join(staged, f), join(d, '.staging-news-2026-11-01', f));
    }
    const deps: CliDeps = {
      kindleDir,
      ebookConvertBin: BIN,
      timeoutMs: 5 * 60 * 1000,
      issues: new IssueRepo(db),
      knownFolders: ['Money', 'News'],
      coverSettings: () => ({ coverTemplate: null, coverTheme: 'dark' }),
      fonts: [],
    };
    const lines: string[] = [];
    expect(await runCli(['--dir', d], deps, (l) => lines.push(l))).toBe(0);
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.split(/\s+/)[0])).toEqual(['imported', 'imported', 'imported']);
    expect(lines[0]).toContain('News 2026-11-01'); // oldest first
    expect(new IssueRepo(db).all().map((i) => `${i.slug} ${i.issueDate}`).sort()).toEqual([
      'money 2026-11-02',
      'money 2026-11-09',
      'news 2026-11-01',
    ]);

    const again: string[] = [];
    expect(await runCli(['--dir', d], deps, (l) => again.push(l))).toBe(0);
    expect(again.map((l) => l.split(/\s+/)[0])).toEqual(['skipped', 'skipped', 'skipped']);
  }, 600_000);
});
