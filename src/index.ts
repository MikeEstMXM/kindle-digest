import { createContext } from './app/context.js';
import { buildServer } from './web/server.js';
import { DailyScheduler } from './scheduler/runner.js';

async function main(): Promise<void> {
  const ctx = createContext();
  const scheduler = new DailyScheduler(ctx);
  const app = buildServer(ctx, scheduler);

  scheduler.start();
  console.log(`[scheduler] Next digest: ${scheduler.nextRunLabel()}`);

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
