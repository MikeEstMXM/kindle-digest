import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildKindleServer, MOBI_TYPE } from '../src/kindle/server.js';

let root: string;
let kindleDir: string;
let app: FastifyInstance;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kd-kindle-'));
  kindleDir = join(root, 'kindle');
  await mkdir(join(kindleDir, 'news'), { recursive: true });
  await mkdir(join(kindleDir, 'tech'), { recursive: true });
  await mkdir(join(kindleDir, '.work', 'news-abc'), { recursive: true });
  await writeFile(join(kindleDir, 'news', 'news-2026-11-09.mobi'), 'OLD-ISSUE');
  await writeFile(join(kindleDir, 'news', 'news-2026-11-10.mobi'), 'NEW-ISSUE');
  await writeFile(join(kindleDir, 'tech', 'tech-2026-11-08.mobi'), 'TECH-ISSUE');
  // Things that must stay invisible.
  await writeFile(join(kindleDir, 'news', 'notes.txt'), 'private');
  await writeFile(join(kindleDir, 'news', 'news-2026-11-10.epub'), 'epub');
  await writeFile(join(kindleDir, '.work', 'news-abc', 'out.mobi'), 'half-written');
  await writeFile(join(root, 'secret.mobi'), 'OUTSIDE');
  await symlink(join(root, 'secret.mobi'), join(kindleDir, 'news', 'news-2026-11-11.mobi'));
  await writeFile(join(kindleDir, 'top-level-2026-11-10.mobi'), 'not in a folder');
  // A symlinked *directory* pointing outside the Kindle dir.
  await mkdir(join(root, 'outside'), { recursive: true });
  await writeFile(join(root, 'outside', 'evil-2026-11-10.mobi'), 'OUTSIDE-DIR');
  await symlink(join(root, 'outside'), join(kindleDir, 'evil'));
  // A long (but valid) slug: Fastify's default 100-char param limit must not break its link.
  const longSlug = 'l'.repeat(66);
  await mkdir(join(kindleDir, longSlug), { recursive: true });
  await writeFile(join(kindleDir, longSlug, `${longSlug}-2026-11-10.mobi`), 'LONG');

  app = buildKindleServer({ kindleDir, logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

describe('Kindle page: issue list', () => {
  it('is plain HTML with no script, listing newest issue first per folder', async () => {
    const res = await app.inject('/');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).not.toMatch(/<script/i);
    // Folder title falls back to the directory name (these fixtures are not real MOBIs).
    expect(res.body.indexOf('news-2026-11-10.mobi')).toBeGreaterThan(-1);
    expect(res.body.indexOf('news-2026-11-10.mobi')).toBeLessThan(
      res.body.indexOf('news-2026-11-09.mobi'),
    );
    expect(res.body).toContain('/issues/tech/tech-2026-11-08.mobi');
  });

  it('lists only real published issues', async () => {
    const body = (await app.inject('/')).body;
    expect(body).not.toContain('notes.txt');
    expect(body).not.toContain('.epub');
    expect(body).not.toContain('.work');
    expect(body).not.toContain('half-written');
    expect(body).not.toContain('top-level');
    expect(body).not.toContain('news-2026-11-11'); // symlink
  });

  it('is empty-but-fine before anything is published', async () => {
    const empty = buildKindleServer({ kindleDir: join(root, 'nope'), logger: false });
    const res = await empty.inject('/');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('No issues published yet');
    await empty.close();
  });
});

describe('Kindle page: downloads', () => {
  it('serves a .mobi with the Kindle content type', async () => {
    const res = await app.inject('/issues/news/news-2026-11-10.mobi');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(MOBI_TYPE);
    expect(res.headers['content-length']).toBe('9');
    expect(res.headers['content-disposition']).toContain('news-2026-11-10.mobi');
    expect(res.body).toBe('NEW-ISSUE');
  });

  it('answers HEAD without a body', async () => {
    const res = await app.inject({ method: 'HEAD', url: '/issues/news/news-2026-11-10.mobi' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(MOBI_TYPE);
  });

  it('serves an issue whose folder slug is long (past Fastify default param limit)', async () => {
    const s = 'l'.repeat(66);
    const res = await app.inject(`/issues/${s}/${s}-2026-11-10.mobi`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('LONG');
  });

  it('does not list a symlinked directory', async () => {
    expect((await app.inject('/')).body).not.toContain('evil');
  });

  const refused = [
    '/issues/news/notes.txt',
    '/issues/news/news-2026-11-10.epub',
    '/issues/news/news-2026-11-11.mobi', // symlink out of the directory
    '/issues/tech/news-2026-11-10.mobi', // issue of another folder
    '/issues/news/missing-2026-11-10.mobi',
    '/issues/news/..%2Fsecret.mobi',
    '/issues/evil/evil-2026-11-10.mobi', // symlinked directory
    '/issues/news/%2e%2e%2fsecret.mobi',
    '/issues/..%2Fnews/news-2026-11-10.mobi',
    '/issues/%2e%2e/kindle/news/news-2026-11-10.mobi',
    '/issues/news/..%5Csecret.mobi',
    '/issues/.work/out.mobi',
    '/issues/.work%2Fnews-abc/out.mobi',
    '/issues/news/news-2026-11-10.mobi%00.txt',
    '/issues/news/',
    '/issues/',
    '/issues',
    '/issues/news/news-2026-11-10.mobi/extra',
    '/../secret.mobi',
    '/%2e%2e/secret.mobi',
  ];
  it.each(refused)('refuses %s', async (url) => {
    const res = await app.inject(url);
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('OUTSIDE');
    expect(res.body).not.toContain('private');
    expect(res.body).not.toContain('half-written');
  });
});

describe('Kindle page: the main app is not reachable through it', () => {
  const appPaths = [
    '/settings',
    '/feeds',
    '/feeds/refresh',
    '/download/News',
    '/download-all',
    '/vendor/htmx.min.js',
    '/toggle',
    '/send/News',
    '/send-all',
    '/feeds/add',
    '/feeds/import',
  ];
  it.each(appPaths)('GET %s is 404', async (url) => {
    expect((await app.inject(url)).statusCode).toBe(404);
  });

  it.each(['POST', 'PUT', 'DELETE', 'PATCH'] as const)(
    '%s / is not allowed to do anything',
    async (method) => {
      const res = await app.inject({
        method,
        url: '/settings',
        payload: { deliveryMode: 'email' },
      });
      expect(res.statusCode).toBe(404);
    },
  );

  it('cannot be used to write', async () => {
    const res = await app.inject({ method: 'POST', url: '/', payload: 'x' });
    expect(res.statusCode).toBe(404);
  });
});
