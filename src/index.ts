import { createContext } from './app/context.js';
import { buildServer } from './web/server.js';
import { DailyScheduler } from './scheduler/runner.js';
import { fetchAllFeeds } from './rss/fetcher.js';

const FEED_REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

async function main(): Promise<void> {
  const ctx = createContext();
  const scheduler = new DailyScheduler(ctx);
  const app = buildServer(ctx, scheduler);

  scheduler.start();
  console.log(`[scheduler] Next digest: ${scheduler.nextRunLabel()}`);

  // Fetch feeds once on startup (brief delay so the server is up first),
  // then every hour.
  setTimeout(() => void fetchAllFeeds(ctx.feeds, ctx.articles), 5_000);
  setInterval(() => void fetchAllFeeds(ctx.feeds, ctx.articles), FEED_REFRESH_INTERVAL_MS);

  await app.listen({ port: ctx.env.port, host: '0.0.0.0' });

  const shutdown = async (): Promise<void> => {
    scheduler.stop();
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
