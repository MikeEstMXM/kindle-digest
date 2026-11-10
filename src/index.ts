import { configureSharp } from './content/sharpConfig.js';
import { createContext } from './app/context.js';
import { buildServer } from './web/server.js';
import { DailyScheduler } from './scheduler/runner.js';
import { DeliveryWorker } from './delivery/worker.js';
import { fetchAllFeeds } from './rss/fetcher.js';
import { buildKindleServer } from './kindle/server.js';
import { clearWorkDir } from './mobi/publish.js';

const FEED_REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

async function main(): Promise<void> {
  // Global libvips state — set before any image work begins.
  configureSharp();
  const ctx = createContext();
  const scheduler = new DailyScheduler(ctx);
  const worker = new DeliveryWorker(ctx);
  const app = buildServer(ctx, scheduler);

  // Recover anything a previous process was mid-way through when it died,
  // then queue any delivery slot that passed while we were down. Both are
  // idempotent, so a restart loop can't duplicate a digest.
  worker.recoverInterrupted();
  await clearWorkDir(ctx.env.kindleDir); // conversion leftovers from a killed run
  scheduler.catchUp();

  scheduler.start();
  worker.start();
  console.log(`[scheduler] Next digest: ${scheduler.nextRunLabel()}`);

  // Fetch feeds once on startup (brief delay so the server is up first),
  // then every hour.
  setTimeout(() => void fetchAllFeeds(ctx.feeds, ctx.articles), 5_000);
  setInterval(() => void fetchAllFeeds(ctx.feeds, ctx.articles), FEED_REFRESH_INTERVAL_MS);

  await app.listen({ port: ctx.env.port, host: '0.0.0.0' });

  // The Kindle page is a second listener on purpose: it is published on the LAN
  // with no login, so it must not share a server with the (unauthenticated)
  // dashboard. See src/kindle/server.ts. KINDLE_PORT=0 turns it off.
  const kindleApp =
    ctx.env.kindlePort > 0 ? buildKindleServer({ kindleDir: ctx.env.kindleDir }) : undefined;
  if (kindleApp) {
    await kindleApp.listen({ port: ctx.env.kindlePort, host: '0.0.0.0' });
  }

  const shutdown = async (): Promise<void> => {
    scheduler.stop();
    worker.stop();
    await app.close();
    await kindleApp?.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
