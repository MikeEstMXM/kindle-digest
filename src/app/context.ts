import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadEnv, type Env } from '../config/env.js';
import { openDb, OWNER_USERNAME, type DB } from '../db/schema.js';
import { SettingsRepo, SelectionRepo, RunLogRepo, DeliveryRepo } from '../db/repositories.js';
import { FeedRepo, ArticleRepo, FolderSettingsRepo } from '../db/feedRepos.js';
import { IssueRepo } from '../db/issueRepo.js';
import { ReaderClient } from '../reader/client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** assets/fonts relative to the project root (src/app -> ../../assets/fonts). */
export const FONTS_DIR = join(__dirname, '..', '..', 'assets', 'fonts');

export interface AppContext {
  env: Env;
  db: DB;
  /** The account every repository below is scoped to (`mharm`; there is no other). */
  userId: number;
  settings: SettingsRepo;
  selection: SelectionRepo;
  runLog: RunLogRepo;
  delivery: DeliveryRepo;
  feeds: FeedRepo;
  articles: ArticleRepo;
  folderSettings: FolderSettingsRepo;
  issues: IssueRepo;
  readerClient(): ReaderClient;
}

export function createContext(): AppContext {
  const env = loadEnv();
  const db = openDb(env.databasePath);
  const owner = db.prepare('SELECT id FROM users WHERE username = ?').get(OWNER_USERNAME) as
    | { id: number }
    | undefined;
  if (!owner) throw new Error(`account "${OWNER_USERNAME}" is missing from the database`);
  const userId = owner.id;

  const settings = new SettingsRepo(db, userId);
  const selection = new SelectionRepo(db);
  const runLog = new RunLogRepo(db);
  const delivery = new DeliveryRepo(db, userId);
  const feeds = new FeedRepo(db, userId);
  const articles = new ArticleRepo(db, userId);
  const folderSettings = new FolderSettingsRepo(db, userId);
  const issues = new IssueRepo(db, userId);

  return {
    env,
    db,
    userId,
    settings,
    selection,
    runLog,
    delivery,
    feeds,
    articles,
    folderSettings,
    issues,
    readerClient() {
      return new ReaderClient(feeds, articles);
    },
  };
}
