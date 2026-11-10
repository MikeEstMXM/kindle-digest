import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readMobiExth } from '../mobi/exth.js';
import { ISSUE_FILE } from '../mobi/publish.js';

export interface Issue {
  file: string;
  /** ISO date from the filename. */
  date: string;
  bytes: number;
}

export interface PublishedFolder {
  /** Directory name (slug) — what appears in URLs. */
  dir: string;
  /** The folder's real name, read from the newest MOBI; falls back to the slug. */
  title: string;
  /** Newest first. */
  issues: Issue[];
}

const DIR_NAME = /^[a-z0-9-]+$/;

/**
 * Scan the Kindle directory. Only `<slug>/<slug>-YYYY-MM-DD.mobi` regular files
 * are ever reported; anything else on disk (work dirs, symlinks, stray files)
 * is invisible. Folders ordered by their newest issue, newest first.
 */
export async function listPublished(kindleDir: string): Promise<PublishedFolder[]> {
  let dirs: string[];
  try {
    dirs = (await readdir(kindleDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && DIR_NAME.test(d.name))
      .map((d) => d.name);
  } catch {
    return [];
  }

  const folders: PublishedFolder[] = [];
  for (const dir of dirs) {
    const issues = await listIssues(kindleDir, dir);
    if (issues.length === 0) continue;
    folders.push({ dir, title: await titleOf(kindleDir, dir, issues[0]), issues });
  }
  return folders.sort(
    (a, b) => b.issues[0].date.localeCompare(a.issues[0].date) || a.title.localeCompare(b.title),
  );
}

async function listIssues(kindleDir: string, dir: string): Promise<Issue[]> {
  const issues: Issue[] = [];
  for (const entry of await readdir(join(kindleDir, dir), { withFileTypes: true })) {
    const m = ISSUE_FILE.exec(entry.name);
    // Dirent.isFile() is false for symlinks, so links are never followed.
    if (!entry.isFile() || !m || m[1] !== dir) continue;
    issues.push({
      file: entry.name,
      date: m[2],
      bytes: (await stat(join(kindleDir, dir, entry.name))).size,
    });
  }
  return issues.sort((a, b) => b.date.localeCompare(a.date));
}

async function titleOf(kindleDir: string, dir: string, newest: Issue): Promise<string> {
  try {
    return (await readMobiExth(join(kindleDir, dir, newest.file))).updatedTitle ?? dir;
  } catch {
    return dir;
  }
}

/**
 * Resolve a requested file to a path on disk, or undefined if it is not a
 * published issue. The names are validated against strict patterns *and*
 * matched against the actual directory listing of regular files, so there is
 * no path to traverse.
 */
export async function resolveIssue(
  kindleDir: string,
  dir: string,
  file: string,
): Promise<{ path: string; bytes: number } | undefined> {
  const m = ISSUE_FILE.exec(file);
  if (!DIR_NAME.test(dir) || !m || m[1] !== dir) return undefined;
  const issues = await listIssues(kindleDir, dir).catch(() => []);
  const hit = issues.find((i) => i.file === file);
  return hit ? { path: join(kindleDir, dir, file), bytes: hit.bytes } : undefined;
}
