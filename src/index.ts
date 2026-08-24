import { configureSharp } from './content/sharpConfig.js';
import { createContext } from './app/context.js';
import { buildServer } from './web/server.js';
import { DailyScheduler } from './scheduler/runner.js';
import { DeliveryWorker } from './delivery/worker.js';
import { fetchAllFeeds } from './rss/fetcher.js';

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
  scheduler.catchUp();

  scheduler.start();
  worker.start();
  console.log(`[scheduler] Next digest: ${scheduler.nextRunLabel()}`);

  // Fetch feeds once on startup (brief delay so the server is up first),
  // then every hour.
  setTimeout(() => void fetchAllFeeds(ctx.feeds, ctx.articles), 5_000);
  setInterval(() => void fetchAllFeeds(ctx.feeds, ctx.articles), FEED_REFRESH_INTERVAL_MS);

  await app.listen({ port: ctx.env.port, host: '0.0.0.0' });

  const shutdown = async (): Promise<void> => {
    scheduler.stop();
    worker.stop();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
