import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { buildMobi, makeKindleDir } from './helpers/mobi.js';
import { makeApp, signIn, testEnv, type SignedIn, type TestApp } from './helpers/app.js';
import { syncIssues } from '../src/issues/sync.js';
import { MOBI_TYPE } from '../src/issues/routes.js';
import { THUMBNAILS_SHOWN } from '../src/issues/views.js';
import { readMobiCover } from '../src/mobi/cover.js';

let fx: Awaited<ReturnType<typeof makeKindleDir>>;
let t: TestApp;
let s: SignedIn;

beforeAll(async () => {
  fx = await makeKindleDir();
});
afterAll(async () => {
  await fx.cleanup();
});

beforeEach(async () => {
  t = makeApp(testEnv({ kindleDir: fx.kindleDir }));
  await syncIssues(t.ctx.issues, fx.kindleDir, ['News', 'Tech']);
  s = await signIn(t);
});

describe('issue archive: listing', () => {
  it('/issues lists each folder with its latest issue and issue count, newest folder first', async () => {
    const res = await s.get('/issues');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).not.toMatch(/<script/i);
    const body = res.body;
    expect(body.indexOf('News')).toBeGreaterThan(-1);
    expect(body.indexOf('News')).toBeLessThan(body.indexOf('Tech')); // News has the newer issue
    expect(body).toContain('Tue 10 Nov 2026');
    expect(body).toContain('2 issues');
    expect(body).toContain('1 issue');
    expect(body).toContain('href="/issues/news/news-2026-11-10.mobi"'); // download latest
    expect(body).toContain('href="/issues/tech"');
  });

  it('/issues/<folder> lists every issue newest first with a big download link', async () => {
    const res = await s.get('/issues/news');
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(/<script/i);
    const i10 = res.body.indexOf('news-2026-11-10.mobi');
    const i09 = res.body.indexOf('news-2026-11-09.mobi');
    expect(i10).toBeGreaterThan(-1);
    expect(i10).toBeLessThan(i09);
    expect(res.body).toContain('class="big"');
    expect(res.body).toMatch(/Mon 9 Nov 2026/);
    expect(res.body).toMatch(/\d\.\d MB/);
  });

  it('shows only real published issues', async () => {
    const all = (await s.get('/issues')).body + (await s.get('/issues/news')).body;
    for (const hidden of [
      'notes.txt',
      '.epub',
      '.work',
      'half-written',
      'top-level',
      'news-2026-11-11',
      'evil',
      'secret',
    ]) {
      expect(all).not.toContain(hidden);
    }
  });

  it('an unknown folder is a 404, and an empty archive says so', async () => {
    expect((await s.get('/issues/nope')).statusCode).toBe(404);
    const empty = makeApp(testEnv({ kindleDir: join(fx.root, 'nope') }));
    const es = await signIn(empty);
    expect((await es.get('/issues')).body).toContain('No issues published yet');
  });

  it('keeps every issue: thirty of them are all listed', async () => {
    await mkdir(join(fx.kindleDir, 'money'), { recursive: true });
    for (let d = 1; d <= 30; d++) {
      const day = String(d).padStart(2, '0');
      await writeFile(join(fx.kindleDir, 'money', `money-2026-10-${day}.mobi`), 'x');
    }
    await syncIssues(t.ctx.issues, fx.kindleDir, ['Money']);
    const body = (await s.get('/issues/money')).body;
    expect(body.match(/money-2026-10-\d\d\.mobi"/g)).toHaveLength(30);
    expect(body).toContain('30 issues');
    expect(body.match(/<img /g)).toHaveLength(THUMBNAILS_SHOWN); // only the newest get covers
    await rm(join(fx.kindleDir, 'money'), { recursive: true, force: true });
  });
});

describe('issue archive: downloads', () => {
  it('serves a .mobi as a Kindle ebook attachment', async () => {
    const res = await s.get('/issues/news/news-2026-11-10.mobi');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(MOBI_TYPE);
    expect(res.headers['content-length']).toBe('9');
    expect(res.headers['content-disposition']).toBe('attachment; filename="news-2026-11-10.mobi"');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.body).toBe('NEW-ISSUE');
  });

  it('answers HEAD without a body', async () => {
    const res = await t.app.inject({
      method: 'HEAD',
      url: '/issues/news/news-2026-11-10.mobi',
      headers: { cookie: s.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(MOBI_TYPE);
    expect(res.body).toBe('');
  });

  it('serves an issue whose folder slug is long (past Fastify default param limit)', async () => {
    const slug = 'l'.repeat(66);
    await mkdir(join(fx.kindleDir, slug), { recursive: true });
    await writeFile(join(fx.kindleDir, slug, `${slug}-2026-11-10.mobi`), 'LONG');
    await syncIssues(t.ctx.issues, fx.kindleDir, []);
    const res = await s.get(`/issues/${slug}/${slug}-2026-11-10.mobi`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('LONG');
    await rm(join(fx.kindleDir, slug), { recursive: true, force: true });
  });

  it('needs a session: logged out it is a redirect to the login page, not a file', async () => {
    for (const url of [
      '/issues',
      '/issues/news',
      '/issues/news/news-2026-11-10.mobi',
      '/issues/news/news-2026-11-10.mobi/cover.jpg',
    ]) {
      const res = await t.app.inject(url);
      expect(res.statusCode, url).toBe(302);
      expect(res.headers.location).toBe(`/login?next=${encodeURIComponent(url)}`);
      expect(res.body).not.toContain('NEW-ISSUE');
    }
    const head = await t.app.inject({ method: 'HEAD', url: '/issues/news/news-2026-11-10.mobi' });
    expect(head.statusCode).toBe(302);
  });

  it('a file that vanished from disk is a 404 and leaves the index', async () => {
    await writeFile(join(fx.kindleDir, 'tech', 'tech-2026-11-07.mobi'), 'GONE-SOON');
    await syncIssues(t.ctx.issues, fx.kindleDir, ['Tech']);
    expect((await s.get('/issues/tech/tech-2026-11-07.mobi')).statusCode).toBe(200);
    await rm(join(fx.kindleDir, 'tech', 'tech-2026-11-07.mobi'));
    expect((await s.get('/issues/tech/tech-2026-11-07.mobi')).statusCode).toBe(404);
    expect(t.ctx.issues.find('tech', 'tech-2026-11-07.mobi')).toBeUndefined();
  });

  const refused = [
    '/issues/news/notes.txt',
    '/issues/news/news-2026-11-10.epub',
    '/issues/news/news-2026-11-11.mobi', // symlink out of the archive
    '/issues/tech/news-2026-11-10.mobi', // issue of another folder
    '/issues/news/missing-2026-11-10.mobi',
    '/issues/news/..%2Fsecret.mobi',
    '/issues/news/%2e%2e%2fsecret.mobi',
    '/issues/..%2Fnews/news-2026-11-10.mobi',
    '/issues/%2e%2e/kindle/news/news-2026-11-10.mobi',
    '/issues/news/..%5Csecret.mobi',
    '/issues/evil/evil-2026-11-10.mobi', // symlinked directory
    '/issues/.work/out.mobi',
    '/issues/.work%2Fnews-abc/out.mobi',
    '/issues/news/news-2026-11-10.mobi%00.txt',
    '/issues/news/',
    '/issues/',
    '/issues/news/news-2026-11-10.mobi/extra',
    '/../secret.mobi',
    '/%2e%2e/secret.mobi',
  ];
  it.each(refused)('refuses %s', async (url) => {
    const res = await s.get(url);
    expect([404, 400]).toContain(res.statusCode);
    for (const leak of ['OUTSIDE', 'private', 'half-written', 'NEW-ISSUE']) {
      expect(res.body).not.toContain(leak);
    }
  });
});

describe('issue archive: cover thumbnails', () => {
  it('extracts the embedded cover from a .mobi and serves a small JPEG', async () => {
    const cover = await sharp({
      create: { width: 600, height: 800, channels: 3, background: '#a33' },
    })
      .jpeg()
      .toBuffer();
    await mkdir(join(fx.kindleDir, 'cov'), { recursive: true });
    const file = join(fx.kindleDir, 'cov', 'cov-2026-11-10.mobi');
    await writeFile(file, buildMobi({ title: 'Cov', cover }));
    expect((await readMobiCover(file))?.equals(cover)).toBe(true);

    await syncIssues(t.ctx.issues, fx.kindleDir, []);
    const page = (await s.get('/issues/cov')).body;
    expect(page).toContain('src="/issues/cov/cov-2026-11-10.mobi/cover.jpg"');
    const img = await s.get('/issues/cov/cov-2026-11-10.mobi/cover.jpg');
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
    const meta = await sharp(img.rawPayload).metadata();
    expect(meta.width).toBe(120);
    expect(img.rawPayload.length).toBeLessThan(cover.length);
    await rm(join(fx.kindleDir, 'cov'), { recursive: true, force: true });
  });

  it('a damaged .mobi gives no thumbnail (404), never a server error', async () => {
    const cover = await sharp({
      create: { width: 60, height: 80, channels: 3, background: '#333' },
    })
      .jpeg()
      .toBuffer();
    const good = buildMobi({ title: 'Bad', cover });
    const exthAt = good.indexOf('EXTH');
    const damaged: Record<string, Buffer> = {
      // header record ends right after the EXTH magic
      'cut-in-exth': Buffer.concat([
        (() => {
          const b = Buffer.from(good.subarray(0, 90));
          b.writeUInt32BE(exthAt + 4, 86);
          return b;
        })(),
        good.subarray(90),
      ]),
      truncated: good.subarray(0, 120),
      'cover-index-huge': (() => {
        const b = Buffer.from(good);
        b.writeUInt32BE(0xfffffff0, b.indexOf(Buffer.from([0, 0, 0, 201])) + 8);
        return b;
      })(),
    };
    await mkdir(join(fx.kindleDir, 'dmg'), { recursive: true });
    for (const [name, data] of Object.entries(damaged)) {
      await writeFile(
        join(
          fx.kindleDir,
          'dmg',
          `dmg-2026-11-${name === 'truncated' ? '01' : name === 'cut-in-exth' ? '02' : '03'}.mobi`,
        ),
        data,
      );
    }
    await syncIssues(t.ctx.issues, fx.kindleDir, []);
    for (const day of ['01', '02', '03']) {
      const res = await s.get(`/issues/dmg/dmg-2026-11-${day}.mobi/cover.jpg`);
      expect(res.statusCode, day).toBe(404);
    }
    await rm(join(fx.kindleDir, 'dmg'), { recursive: true, force: true });
  });

  it('is a 404 when the file has no usable cover', async () => {
    const res = await s.get('/issues/news/news-2026-11-10.mobi/cover.jpg'); // fixture is not a real MOBI
    expect(res.statusCode).toBe(404);
  });
});

describe('index sync', () => {
  it('learns issues that were on disk before the archive existed, using the real folder name', async () => {
    expect(t.ctx.issues.folders().map((f) => f.folder)).toEqual(['News', 'Tech']);
    expect(t.ctx.issues.list('news').map((i) => i.issueDate)).toEqual(['2026-11-10', '2026-11-09']);
  });

  it('names an unknown folder from the MOBI itself, else its slug', async () => {
    await mkdir(join(fx.kindleDir, 'misc'), { recursive: true });
    await mkdir(join(fx.kindleDir, 'plain'), { recursive: true });
    await writeFile(
      join(fx.kindleDir, 'misc', 'misc-2026-11-10.mobi'),
      buildMobi({ title: 'Misc Reading' }),
    );
    await writeFile(join(fx.kindleDir, 'plain', 'plain-2026-11-10.mobi'), 'not a mobi');
    await syncIssues(t.ctx.issues, fx.kindleDir, []);
    const names = Object.fromEntries(t.ctx.issues.folders().map((f) => [f.slug, f.folder]));
    expect(names.misc).toBe('Misc Reading');
    expect(names.plain).toBe('plain');
    await rm(join(fx.kindleDir, 'misc'), { recursive: true, force: true });
    await rm(join(fx.kindleDir, 'plain'), { recursive: true, force: true });
  });

  it('forgets files that are gone, but never wipes the index when the directory cannot be read', async () => {
    const before = t.ctx.issues.all().length;
    expect(await syncIssues(t.ctx.issues, join(fx.root, 'unmounted'), [])).toEqual({
      added: 0,
      removed: 0,
    });
    expect(t.ctx.issues.all()).toHaveLength(before);

    await writeFile(join(fx.kindleDir, 'tech', 'tech-2026-11-06.mobi'), 'x');
    await syncIssues(t.ctx.issues, fx.kindleDir, ['Tech']);
    await rm(join(fx.kindleDir, 'tech', 'tech-2026-11-06.mobi'));
    expect((await syncIssues(t.ctx.issues, fx.kindleDir, ['Tech'])).removed).toBe(1);
    expect(t.ctx.issues.find('tech', 'tech-2026-11-06.mobi')).toBeUndefined();
  });

  it('is idempotent', async () => {
    expect(await syncIssues(t.ctx.issues, fx.kindleDir, ['News', 'Tech'])).toEqual({
      added: 0,
      removed: 0,
    });
  });
});
