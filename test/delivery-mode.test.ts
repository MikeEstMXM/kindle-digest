import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { openDb, migrate, type DB } from '../src/db/schema.js';
import { SettingsRepo, DeliveryRepo } from '../src/db/repositories.js';
import type { Env } from '../src/config/env.js';
import type { AppContext } from '../src/app/context.js';
import { resolveSettings, parseDeliveryMode } from '../src/app/settings.js';
import { DeliveryWorker, type DeliveryDeps } from '../src/delivery/worker.js';
import { PermanentConversionError } from '../src/mobi/convert.js';
import { makeApp, signIn } from './helpers/app.js';
import { deliveryPanel, settingsPage } from '../src/web/views.js';

function fakeEnv(over: Partial<Env['defaults']> = {}): Env {
  return {
    port: 3000,
    appBaseUrl: 'http://localhost:3000',
    databasePath: ':memory:',
    smtp: { port: 587, secure: false },
    defaults: { deliveryTime: '06:30', timezone: 'UTC', deliveryMode: 'download', ...over },
    fulltextMinChars: 1800,
    digestDir: '/tmp/none',
    deliveryMaxAttempts: 5,
    buildConcurrency: 1,
    kindleDir: '/tmp/none-kindle',
    kindleKeepIssues: 0,
    ebookConvertBin: 'ebook-convert',
    convertTimeoutMs: 1000,
  };
}

let db: DB;
let ctx: AppContext;
let deps: DeliveryDeps;
let send: ReturnType<typeof vi.fn>;
let publish: ReturnType<typeof vi.fn>;
let alert: ReturnType<typeof vi.fn>;

function makeCtx(env: Env): AppContext {
  // Only the parts the worker and the settings route touch.
  return {
    env,
    db,
    settings: new SettingsRepo(db),
    delivery: new DeliveryRepo(db),
  } as unknown as AppContext;
}

/** A delivery that has been built and is waiting to be delivered. */
function builtRow(folder = 'News', date = '2026-11-10'): number {
  ctx.delivery.enqueue(date, folder);
  const row = ctx.delivery.find(date, folder)!;
  ctx.delivery.markBuilt(row.id, `/data/digests/${folder}-${date}.epub`, 1234, 5);
  return row.id;
}

async function runWorker(): Promise<void> {
  const worker = new DeliveryWorker(ctx, 60_000, deps);
  await worker.tick();
  worker.stop();
}

beforeEach(() => {
  db = openDb(':memory:');
  ctx = makeCtx(fakeEnv());
  send = vi.fn(async () => ({ messageId: '<m@x>' }));
  publish = vi.fn(async () => ({
    mobiPath: '/data/kindle/news/news-2026-11-10.mobi',
    bytes: 2048,
  }));
  alert = vi.fn(async () => undefined);
  deps = { send, publish, alert } as unknown as DeliveryDeps;
});

describe('delivery mode setting', () => {
  it('defaults to download', () => {
    expect(resolveSettings(ctx.env, ctx.settings).deliveryMode).toBe('download');
  });

  it('treats anything unrecognised as download, never email', () => {
    expect(parseDeliveryMode(undefined)).toBe('download');
    expect(parseDeliveryMode('')).toBe('download');
    expect(parseDeliveryMode('EMAIL')).toBe('download');
    expect(parseDeliveryMode('smtp')).toBe('download');
    expect(parseDeliveryMode('email')).toBe('email');
  });

  it('is stored in the DB and wins over the env default', () => {
    const emailEnv = makeCtx(fakeEnv({ deliveryMode: 'email' }));
    expect(resolveSettings(emailEnv.env, emailEnv.settings).deliveryMode).toBe('email');
    emailEnv.settings.set('deliveryMode', 'download');
    expect(resolveSettings(emailEnv.env, emailEnv.settings).deliveryMode).toBe('download');
  });

  it('is saved from the Settings page, and junk values fall back to download', async () => {
    const t = makeApp(fakeEnv());
    const session = await signIn(t);
    const post = (deliveryMode: string) => session.post('/settings', { deliveryMode });
    expect((await post('email')).statusCode).toBe(302);
    expect(resolveSettings(t.ctx.env, t.ctx.settings).deliveryMode).toBe('email');
    await post('carrier-pigeon');
    expect(resolveSettings(t.ctx.env, t.ctx.settings).deliveryMode).toBe('download');
    await t.app.close();
  });

  it('shows on the Settings page with the current choice selected', () => {
    const s = resolveSettings(ctx.env, ctx.settings);
    expect(settingsPage(s, ['UTC'])).toMatch(/<option value="download" selected>/);
    ctx.settings.set('deliveryMode', 'email');
    const e = resolveSettings(ctx.env, ctx.settings);
    expect(settingsPage(e, ['UTC'])).toMatch(/<option value="email" selected>/);
  });
});

describe('download mode', () => {
  it('publishes, marks the delivery published, and never touches SMTP', async () => {
    const id = builtRow();
    await runWorker();

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0].slice(1)).toEqual([
      'News',
      '2026-11-10',
      '/data/digests/News-2026-11-10.epub',
    ]);
    expect(send).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
    const row = ctx.delivery.get(id)!;
    expect(row.state).toBe('published');
    expect(row.mobi_path).toBe('/data/kindle/news/news-2026-11-10.mobi');
    expect(row.message_id).toBeNull();
  });

  it('records a conversion failure, retries it, and keeps the scheduler alive', async () => {
    publish.mockRejectedValueOnce(new Error('ebook-convert failed: exit code 1\nQt blew up'));
    const id = builtRow();
    await runWorker();

    const row = ctx.delivery.get(id)!;
    expect(row.state).toBe('built'); // back in the queue, EPUB kept; will not rebuild
    expect(row.attempts).toBe(1);
    expect(row.last_error).toMatch(/Qt blew up/);
    expect(send).not.toHaveBeenCalled();
  });

  it('fails permanently on a conversion that cannot succeed, visibly, without email', async () => {
    publish.mockRejectedValueOnce(
      new PermanentConversionError('ebook-convert timed out after 1200s'),
    );
    const id = builtRow();
    await runWorker();

    const row = ctx.delivery.get(id)!;
    expect(row.state).toBe('failed');
    expect(row.last_error).toMatch(/timed out/);
    // Next tick would send the alert in email mode; in download mode it is
    // swallowed (and marked) rather than attempted over SMTP.
    await runWorker();
    expect(alert).not.toHaveBeenCalled();
    expect(ctx.delivery.get(id)!.alerted_at).not.toBeNull();
  });

  it('one folder failing does not stop the next', async () => {
    publish
      .mockRejectedValueOnce(new PermanentConversionError('bad'))
      .mockResolvedValueOnce({ mobiPath: '/data/kindle/tech/tech-2026-11-10.mobi', bytes: 1 });
    const a = builtRow('News');
    const b = builtRow('Tech');
    await runWorker();
    await runWorker();

    expect(ctx.delivery.get(a)!.state).toBe('failed');
    expect(ctx.delivery.get(b)!.state).toBe('published');
  });
});

describe('email mode', () => {
  beforeEach(() => ctx.settings.set('deliveryMode', 'email'));

  it('sends by SMTP as before and never converts', async () => {
    const id = builtRow();
    await runWorker();

    expect(send).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
    const row = ctx.delivery.get(id)!;
    expect(row.state).toBe('sent');
    expect(row.message_id).toBe('<m@x>');
  });

  it('still alerts by email when a send permanently fails', async () => {
    send.mockRejectedValueOnce(
      Object.assign(new Error('535 bad credentials'), { responseCode: 535 }),
    );
    const id = builtRow();
    await runWorker();
    expect(ctx.delivery.get(id)!.state).toBe('failed');
    await runWorker();
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it('flipping back to download takes effect on the next delivery', async () => {
    builtRow('News');
    await runWorker();
    ctx.settings.set('deliveryMode', 'download');
    builtRow('Tech');
    await runWorker();
    expect(send).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

describe('dashboard delivery panel', () => {
  it('shows "published", not "sent", for download mode', () => {
    builtRow();
    const id = ctx.delivery.recent()[0].id;
    ctx.delivery.markPublished(id, '/data/kindle/news/news-2026-11-10.mobi');
    const html = deliveryPanel(ctx.delivery.recent(), 'UTC');
    expect(html).toContain('state published');
    expect(html).not.toContain('state sent');
    expect(html).toContain('News');
  });

  it('shows a failed conversion with its error', () => {
    builtRow();
    const id = ctx.delivery.recent()[0].id;
    ctx.delivery.recordFailure(id, 'ebook-convert failed: <b>oops</b>', {
      retry: false,
      hasBuild: true,
      nextAttemptAt: 0,
    });
    const html = deliveryPanel(ctx.delivery.recent(), 'UTC');
    expect(html).toContain('state failed');
    expect(html).toContain('ebook-convert failed: &lt;b&gt;oops&lt;/b&gt;'); // escaped
  });

  it('renders nothing before there is any history', () => {
    expect(deliveryPanel([], 'UTC')).toBe('');
  });
});

describe('delivery table migration', () => {
  it('adds mobi_path to a database from before periodical delivery', () => {
    const old = new Database(':memory:');
    old.exec(`CREATE TABLE delivery (
      id INTEGER PRIMARY KEY AUTOINCREMENT, digest_date TEXT NOT NULL, folder TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL, epub_path TEXT, epub_bytes INTEGER, article_count INTEGER,
      message_id TEXT, last_error TEXT, claimed_at INTEGER, alerted_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (digest_date, folder));
      INSERT INTO delivery (digest_date, folder, state, next_attempt_at, created_at, updated_at)
      VALUES ('2026-11-01', 'News', 'sent', 1, 1, 1);`);
    migrate(old);
    migrate(old); // idempotent
    const cols = (old.prepare('PRAGMA table_info(delivery)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain('mobi_path');
    expect(old.prepare('SELECT state, mobi_path FROM delivery').get()).toEqual({
      state: 'sent',
      mobi_path: null,
    });
  });
});
