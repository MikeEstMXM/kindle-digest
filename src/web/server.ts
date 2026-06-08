import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import type { AppContext } from '../app/context.js';
import { resolveSettings } from '../app/settings.js';
import { sendAll, sendFolder, todayIso } from '../digest/service.js';
import { fetchAllFeeds, fetchFeed } from '../rss/fetcher.js';
import { parseOpml } from '../rss/opml.js';
import type { DailyScheduler } from '../scheduler/runner.js';
import {
  layout,
  dashboard,
  noFeedsPrompt,
  settingsPage,
  feedsPage,
  sendResults,
  articleRowFragment,
  type DashboardFolder,
} from './views.js';

const require = createRequire(import.meta.url);
const HTMX_JS = readFileSync(require.resolve('htmx.org/dist/htmx.min.js'), 'utf8');

const COMMON_TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Asia/Tokyo',
  'Asia/Kolkata',
  'Australia/Sydney',
  'UTC',
];

export function buildServer(ctx: AppContext, scheduler?: DailyScheduler): FastifyInstance {
  const app = Fastify({ logger: true });
  app.register(formbody);
  app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024 } }); // 2 MB

  app.get('/vendor/htmx.min.js', async (_req, reply) => {
    reply.header('Content-Type', 'application/javascript').send(HTMX_JS);
  });

  // ─── Dashboard ──────────────────────────────────────────────────────────
  app.get('/', async (_req, reply) => {
    const settings = resolveSettings(ctx.env, ctx.settings);
    const date = todayIso(settings.timezone);
    const folders = ctx.feeds.folders();
    if (folders.length === 0) {
      return reply
        .type('text/html')
        .send(layout('Dashboard', noFeedsPrompt()));
    }
    try {
      const client = ctx.readerClient();
      const view: DashboardFolder[] = [];
      for (const folder of folders) {
        const fs = ctx.folderSettings.get(folder);
        const windowMs = fs.cadence === 'weekly' ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
        const allArticles = await client.getRecentByFolder(folder, Date.now() - windowMs);
        if (allArticles.length === 0) continue;
        const excluded = ctx.selection.excludedIds(date);
        const included = allArticles.filter((a) => !excluded.has(a.itemId));
        const excluded2 = allArticles.filter((a) => excluded.has(a.itemId));
        view.push({
          folder,
          cadence: fs.cadence,
          articles: [...included, ...excluded2].map((article) => ({
            article,
            included: !excluded.has(article.itemId),
          })),
        });
      }
      return reply.type('text/html').send(layout('Dashboard', dashboard(date, view)));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.type('text/html').send(layout('Dashboard', noFeedsPrompt(msg)));
    }
  });

  // ─── Toggle include/exclude ─────────────────────────────────────────────
  app.post('/toggle', async (req, reply) => {
    const b = req.body as Record<string, string>;
    const included = b.included === 'true';
    ctx.selection.setIncluded(b.date, b.itemId, b.folder, included);
    return reply
      .type('text/html')
      .send(
        articleRowFragment(
          b.date,
          b.folder,
          { itemId: b.itemId, title: b.title, feedTitle: b.feedTitle },
          included,
        ),
      );
  });

  // ─── Manual send ────────────────────────────────────────────────────────
  app.post('/send/:folder', async (req, reply) => {
    const folder = decodeURIComponent((req.params as { folder: string }).folder);
    try {
      const result = await sendFolder(ctx, folder);
      return reply.type('text/html').send(sendResults([result]));
    } catch (err) {
      return reply.type('text/html').send(
        sendResults([
          { folder, articleCount: 0, status: 'error', message: err instanceof Error ? err.message : String(err) },
        ]),
      );
    }
  });

  app.post('/send-all', async (_req, reply) => {
    const results = await sendAll(ctx);
    return reply.type('text/html').send(sendResults(results));
  });

  // ─── Feed management ────────────────────────────────────────────────────
  app.get('/feeds', async (_req, reply) => {
    const allFeeds = ctx.feeds.all();
    const fsMap = ctx.folderSettings.allAsMap();
    return reply.type('text/html').send(layout('Feeds', feedsPage(allFeeds, fsMap)));
  });

  app.post('/feeds/add', async (req, reply) => {
    const b = req.body as Record<string, string>;
    const url = (b.url ?? '').trim();
    const folder = (b.folder ?? '').trim() || 'Uncategorized';
    if (!url) return reply.redirect('/feeds');
    const feed = ctx.feeds.add(url, url, folder); // title filled in after first fetch
    try {
      await fetchFeed(feed.id, feed.url, ctx.articles, ctx.feeds);
    } catch {
      // Non-fatal: feed saved, will retry on next refresh cycle.
    }
    return reply.redirect('/feeds');
  });

  app.post('/feeds/:id/delete', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    ctx.feeds.delete(id);
    return reply.redirect('/feeds');
  });

  app.post('/feeds/:id/move', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const b = req.body as Record<string, string>;
    const folder = (b.folder ?? '').trim() || 'Uncategorized';
    ctx.feeds.moveToFolder(id, folder);
    return reply.redirect('/feeds');
  });

  app.post('/feeds/:folder/rename', async (req, reply) => {
    const oldName = decodeURIComponent((req.params as { folder: string }).folder);
    const b = req.body as Record<string, string>;
    const newName = (b.newName ?? '').trim();
    if (newName && newName !== oldName) {
      ctx.feeds.renameFolder(oldName, newName);
      ctx.folderSettings.renameFolder(oldName, newName);
      ctx.selection.renameFolder(oldName, newName);
    }
    return reply.redirect('/feeds');
  });

  app.post('/feeds/:folder/cadence', async (req, reply) => {
    const folder = decodeURIComponent((req.params as { folder: string }).folder);
    const b = req.body as Record<string, string>;
    const cadence = b.cadence === 'weekly' ? 'weekly' : 'daily';
    const deliveryDay = Math.min(6, Math.max(0, Number(b.deliveryDay ?? 0)));
    ctx.folderSettings.set(folder, cadence, deliveryDay);
    return reply.redirect('/feeds');
  });

  app.post('/feeds/refresh', async (_req, reply) => {
    void fetchAllFeeds(ctx.feeds, ctx.articles); // fire and forget
    return reply.redirect('/feeds');
  });

  app.post('/feeds/import', async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.redirect('/feeds');
    const buf = await file.toBuffer();
    const feeds = parseOpml(buf.toString('utf-8'));
    let added = 0;
    for (const f of feeds) {
      try {
        ctx.feeds.add(f.url, f.title, f.folder);
        added += 1;
      } catch {
        // duplicate URL — skip
      }
    }
    if (added > 0) void fetchAllFeeds(ctx.feeds, ctx.articles);
    return reply.redirect('/feeds');
  });

  // ─── Settings ───────────────────────────────────────────────────────────
  app.get('/settings', async (_req, reply) => {
    const s = resolveSettings(ctx.env, ctx.settings);
    const tzs = [...new Set([s.timezone, ...COMMON_TIMEZONES])];
    return reply.type('text/html').send(layout('Settings', settingsPage(s, tzs)));
  });

  app.post('/settings', async (req, reply) => {
    const b = req.body as Record<string, string>;
    const keys = [
      'kindleEmail',
      'deliveryTime',
      'timezone',
      'smtpHost',
      'smtpPort',
      'smtpSecure',
      'smtpUser',
      'smtpFrom',
    ];
    for (const k of keys) if (b[k] !== undefined) ctx.settings.set(k, b[k]);
    if (b.smtpPass) ctx.settings.set('smtpPass', b.smtpPass);
    scheduler?.stop();
    scheduler?.start();
    return reply.redirect('/settings');
  });

  return app;
}
