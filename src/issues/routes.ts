import { open, type FileHandle } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app/context.js';
import { mobiThumbnail } from '../mobi/cover.js';
import { resolveIssue } from './scan.js';
import { issueListPage, issuesIndexPage } from './views.js';

export const MOBI_TYPE = 'application/x-mobipocket-ebook';

const THUMB_CACHE_MAX = 500;

/**
 * The issue archive: /issues (folders), /issues/<folder> (every issue, newest
 * first), /issues/<folder>/<file>.mobi (the download) and its cover thumbnail.
 *
 * Registered after the auth hooks, so every one of these needs a session. The
 * database says what exists; the file name and folder in the URL are then
 * checked against a strict pattern and against the real file (not a symlink)
 * before anything is read, so there is no path to traverse.
 */
export function registerIssueRoutes(app: FastifyInstance, ctx: AppContext): void {
  const thumbs = new Map<string, Buffer>();

  const notFound = (reply: {
    code(n: number): { type(t: string): { send(b: string): unknown } };
  }) => reply.code(404).type('text/plain').send('Not found');

  app.get('/issues', async (req, reply) =>
    reply
      .type('text/html; charset=utf-8')
      .send(issuesIndexPage(ctx.issues.folders(), req.session!.csrf)),
  );

  app.get('/issues/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const issues = ctx.issues.list(slug);
    if (issues.length === 0) return notFound(reply);
    return reply
      .type('text/html; charset=utf-8')
      .send(issueListPage(issues[0].folder, slug, issues, req.session!.csrf));
  });

  app.get('/issues/:slug/:file', async (req, reply) => {
    const { slug, file } = req.params as { slug: string; file: string };
    const hit = await locate(slug, file);
    if (!hit) return notFound(reply);
    // Size comes from the open handle, which also survives the file being
    // replaced mid-download.
    let fh: FileHandle;
    try {
      fh = await open(hit.path, 'r');
    } catch {
      return notFound(reply);
    }
    const { size } = await fh.stat();
    reply
      .header('Content-Type', MOBI_TYPE)
      .header('Content-Length', size)
      .header('Content-Disposition', `attachment; filename="${file}"`)
      .header('Cache-Control', 'private, no-cache');
    if (req.method === 'HEAD') {
      await fh.close();
      return reply.send();
    }
    return reply.send(fh.createReadStream());
  });

  app.get('/issues/:slug/:file/cover.jpg', async (req, reply) => {
    const { slug, file } = req.params as { slug: string; file: string };
    const hit = await locate(slug, file);
    if (!hit) return notFound(reply);
    const key = `${slug}/${file}:${hit.bytes}`;
    let jpeg = thumbs.get(key);
    if (!jpeg) {
      jpeg = await mobiThumbnail(hit.path);
      if (!jpeg) return notFound(reply);
      if (thumbs.size >= THUMB_CACHE_MAX) thumbs.delete(thumbs.keys().next().value as string);
      thumbs.set(key, jpeg);
    }
    return reply.type('image/jpeg').header('Cache-Control', 'private, max-age=86400').send(jpeg);
  });

  /** An issue that is in the index *and* really on disk; a missing file leaves the index. */
  async function locate(
    slug: string,
    file: string,
  ): Promise<{ path: string; bytes: number } | undefined> {
    const row = ctx.issues.find(slug, file);
    if (!row) return undefined;
    const onDisk = await resolveIssue(ctx.env.kindleDir, slug, file);
    if (!onDisk) ctx.issues.forget(slug, [file]);
    return onDisk;
  }
}
