import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import type { AppContext } from '../app/context.js';
import { resolveSettings } from '../app/settings.js';
import { buildAuthorizeUrl, exchangeCode } from '../inoreader/oauth.js';
import { sendAll, sendFolder, todayIso } from '../digest/service.js';
import type { DailyScheduler } from '../scheduler/runner.js';
import {
  layout,
  dashboard,
  connectPrompt,
  settingsPage,
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

  app.get('/vendor/htmx.min.js', async (_req, reply) => {
    reply.header('Content-Type', 'application/javascript').send(HTMX_JS);
  });

  // ─── Dashboard ──────────────────────────────────────────────────────────
  app.get('/', async (_req, reply) => {
    const settings = resolveSettings(ctx.env, ctx.settings);
    const date = todayIso(settings.timezone);
    const connected = Boolean(ctx.tokens.load('inoreader'));
    if (!connected) {
      return reply
        .type('text/html')
        .send(layout('Dashboard', connectPrompt('Authorize the app to read your feeds.'), false));
    }
    try {
      const client = ctx.inoreaderClient();
      const folders = await client.getFolders();
      const view: DashboardFolder[] = [];
      for (const folder of folders) {
        const articles = await client.getUnreadByFolder(folder);
        if (articles.length === 0) continue;
        view.push({
          folder,
          articles: articles.map((article) => ({
            article,
            included: ctx.selection.isIncluded(date, article.itemId),
          })),
        });
      }
      return reply.type('text/html').send(layout('Dashboard', dashboard(date, view), true));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.type('text/html').send(layout('Dashboard', connectPrompt(msg), true));
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

  // ─── Settings ───────────────────────────────────────────────────────────
  app.get('/settings', async (_req, reply) => {
    const s = resolveSettings(ctx.env, ctx.settings);
    const tzs = [...new Set([s.timezone, ...COMMON_TIMEZONES])];
    return reply.type('text/html').send(layout('Settings', settingsPage(s, tzs), true));
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
    // Only overwrite the password when a new value is supplied.
    if (b.smtpPass) ctx.settings.set('smtpPass', b.smtpPass);
    scheduler?.stop();
    scheduler?.start();
    return reply.redirect('/settings');
  });

  // ─── Inoreader OAuth ────────────────────────────────────────────────────
  app.get('/auth/inoreader', async (_req, reply) => {
    const state = randomUUID();
    ctx.settings.set('oauth_state', state);
    return reply.redirect(buildAuthorizeUrl(ctx.env.inoreader, state));
  });

  app.get('/auth/callback', async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string };
    if (q.error) return reply.type('text/html').send(layout('Error', `OAuth error: ${q.error}`, false));
    if (!q.code || q.state !== ctx.settings.get('oauth_state')) {
      return reply.type('text/html').send(layout('Error', 'Invalid OAuth state or missing code.', false));
    }
    const tokens = await exchangeCode(ctx.env.inoreader, q.code);
    ctx.tokens.save('inoreader', tokens);
    return reply.redirect('/');
  });

  return app;
}
