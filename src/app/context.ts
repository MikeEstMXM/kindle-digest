import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadEnv, type Env } from '../config/env.js';
import { openDb, type DB } from '../db/schema.js';
import {
  SettingsRepo,
  TokenRepo,
  SelectionRepo,
  RunLogRepo,
} from '../db/repositories.js';
import { InoreaderClient } from '../inoreader/client.js';
import { getValidAccessToken } from '../inoreader/oauth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** assets/fonts relative to the project root (src/app -> ../../assets/fonts). */
export const FONTS_DIR = join(__dirname, '..', '..', 'assets', 'fonts');

export interface AppContext {
  env: Env;
  db: DB;
  settings: SettingsRepo;
  tokens: TokenRepo;
  selection: SelectionRepo;
  runLog: RunLogRepo;
  /** Build an Inoreader client that auto-refreshes the stored token. */
  inoreaderClient(): InoreaderClient;
}

export function createContext(): AppContext {
  const env = loadEnv();
  const db = openDb(env.databasePath);
  const settings = new SettingsRepo(db);
  const tokens = new TokenRepo(db, env.credentialEncryptionKey);
  const selection = new SelectionRepo(db);
  const runLog = new RunLogRepo(db);

  return {
    env,
    db,
    settings,
    tokens,
    selection,
    runLog,
    inoreaderClient() {
      return new InoreaderClient({
        getAccessToken: () => getValidAccessToken(env.inoreader, tokens),
      });
    },
  };
}
