import { existsSync, statSync } from 'node:fs';
import { FONTS_DIR } from '../app/context.js';
import { configureSharp } from '../content/sharpConfig.js';
import { loadEnv } from '../config/env.js';
import { loadFontBuffers } from '../cover/fontLoader.js';
import { FeedRepo, FolderSettingsRepo } from '../db/feedRepos.js';
import { IssueRepo } from '../db/issueRepo.js';
import { openDb, OWNER_USERNAME } from '../db/schema.js';
import { runCli } from './cli.js';

/**
 * `npm run import-issue -- …` / `node dist/import/main.js …`
 * Runs in the app's container against its own DB and KINDLE_DIR.
 */
async function main(): Promise<number> {
  const env = loadEnv();
  // openDb would quietly create an empty database at a mistyped path.
  if (!existsSync(env.databasePath)) {
    console.error(`failed    no database at ${env.databasePath} (DATABASE_PATH); refusing to create one`);
    return 1;
  }
  configureSharp();
  // `docker exec` runs as root unless told otherwise, and files root creates
  // under /data (a new folder directory, the database's WAL) can then not be
  // written by the app, which runs as an unprivileged user.
  const uid = process.getuid?.();
  if (uid === 0) {
    for (const path of [env.databasePath, env.kindleDir]) {
      const owner = statSync(path, { throwIfNoEntry: false })?.uid;
      if (owner !== undefined && owner !== 0) {
        console.error(
          `failed    running as root, but ${path} belongs to uid ${owner}; run as the app user (docker exec -u ${owner} …)`,
        );
        return 1;
      }
    }
  }
  const db = openDb(env.databasePath);
  try {
    const owner = db.prepare('SELECT id FROM users WHERE username = ?').get(OWNER_USERNAME) as
      | { id: number }
      | undefined;
    if (!owner) throw new Error(`account "${OWNER_USERNAME}" is missing from the database`);
    const userId = owner.id;
    const issues = new IssueRepo(db, userId);
    const feeds = new FeedRepo(db, userId);
    const folderSettings = new FolderSettingsRepo(db, userId);
    return await runCli(process.argv.slice(2), {
      kindleDir: env.kindleDir,
      ebookConvertBin: env.ebookConvertBin,
      timeoutMs: env.convertTimeoutMs,
      issues,
      knownFolders: [...new Set([...feeds.folders(), ...issues.all().map((i) => i.folder)])],
      coverSettings: (folder) => folderSettings.get(folder),
      fonts: loadFontBuffers(FONTS_DIR),
    });
  } finally {
    db.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('failed   ', err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
