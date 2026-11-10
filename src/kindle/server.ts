import { createReadStream } from 'node:fs';
import { DateTime } from 'luxon';
import Fastify, { type FastifyInstance } from 'fastify';
import { escapeHtml } from '../util/html.js';
import { listPublished, resolveIssue, type PublishedFolder } from './issues.js';

export const MOBI_TYPE = 'application/x-mobipocket-ebook';

/**
 * The Kindle page: a second, separate Fastify instance on its own port.
 *
 * It exists because the Kindle's browser cannot pass Cloudflare Access and the
 * main app has no login — so what is exposed on the home network must be a
 * different server that *only* knows two routes (the issue list and the .mobi
 * files). It shares no routes, no app context and no database with the main
 * app; all it is given is a directory.
 */
export function buildKindleServer(opts: { kindleDir: string; logger?: boolean }): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? true });

  app.get('/', async (_req, reply) => {
    const folders = await listPublished(opts.kindleDir);
    return reply
      .header('Cache-Control', 'no-cache')
      .type('text/html; charset=utf-8')
      .send(page(folders));
  });

  app.get('/issues/:dir/:file', async (req, reply) => {
    const { dir, file } = req.params as { dir: string; file: string };
    const hit = await resolveIssue(opts.kindleDir, dir, file);
    if (!hit) return reply.code(404).type('text/plain').send('Not found');
    return reply
      .header('Content-Type', MOBI_TYPE)
      .header('Content-Length', hit.bytes)
      .header('Content-Disposition', `attachment; filename="${file}"`)
      .header('X-Content-Type-Options', 'nosniff')
      .send(createReadStream(hit.path));
  });

  // Everything else — including every path the main app serves — is a 404.
  app.setNotFoundHandler((_req, reply) => reply.code(404).type('text/plain').send('Not found'));
  return app;
}

const STYLE = `
  body { font-family: serif; font-size: 22px; margin: 0; padding: 12px; color: #000; background: #fff; }
  h1 { font-size: 30px; margin: 8px 0 16px; }
  h2 { font-size: 26px; margin: 28px 0 8px; border-bottom: 2px solid #000; }
  a { display: block; padding: 18px 12px; margin: 8px 0; border: 2px solid #000; color: #000;
      text-decoration: none; font-size: 24px; }
  a.old { font-size: 20px; padding: 12px; border-width: 1px; }
  small { font-size: 18px; }
  p { margin: 12px 0; }
`;

function page(folders: PublishedFolder[]): string {
  const body =
    folders.length === 0 ? '<p>No issues published yet.</p>' : folders.map(section).join('\n');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kindle Digest</title><style>${STYLE}</style></head>
<body><h1>Kindle Digest</h1>
${body}
</body></html>`;
}

function section(f: PublishedFolder): string {
  const links = f.issues
    .map((issue, i) => {
      const date = DateTime.fromISO(issue.date).toFormat('ccc d LLL yyyy');
      const mb = (issue.bytes / 1024 / 1024).toFixed(1);
      const href = `/issues/${encodeURIComponent(f.dir)}/${encodeURIComponent(issue.file)}`;
      return `<a${i === 0 ? '' : ' class="old"'} href="${href}">${escapeHtml(date)} <small>${mb} MB</small></a>`;
    })
    .join('\n');
  return `<h2>${escapeHtml(f.title)}</h2>\n${links}`;
}
