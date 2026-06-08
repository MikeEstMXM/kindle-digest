import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadEnv, type Env } from '../config/env.js';
import { openDb, type DB } from '../db/schema.js';
import { SettingsRepo, SelectionRepo, RunLogRepo } from '../db/repositories.js';
import { FeedRepo, ArticleRepo } from '../db/feedRepos.js';
import { ReaderClient } from '../reader/client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** assets/fonts relative to the project root (src/app -> ../../assets/fonts). */
export const FONTS_DIR = join(__dirname, '..', '..', 'assets', 'fonts');

export interface AppContext {
  env: Env;
  db: DB;
  settings: SettingsRepo;
  selection: SelectionRepo;
  runLog: RunLogRepo;
  feeds: FeedRepo;
  articles: ArticleRepo;
  readerClient(): ReaderClient;
}

export function createContext(): AppContext {
  const env = loadEnv();
  const db = openDb(env.databasePath);
  const settings = new SettingsRepo(db);
  const selection = new SelectionRepo(db);
  const runLog = new RunLogRepo(db);
  const feeds = new FeedRepo(db);
  const articles = new ArticleRepo(db);

  return {
    env,
    db,
    settings,
    selection,
    runLog,
    feeds,
    articles,
    readerClient() {
      return new ReaderClient(feeds, articles);
    },
  };
}
