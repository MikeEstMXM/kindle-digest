import { lstat, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ISSUE_FILE } from '../mobi/publish.js';

/**
 * Looking at the issue files on disk. The database is what the archive pages
 * list; this is how it learns about files it did not publish itself (issues
 * from before accounts existed) and how a download is checked against the real
 * file before a byte is sent.
 */

export interface DiskIssue {
  file: string;
  /** ISO date from the filename. */
  date: string;
  bytes: number;
}

export interface DiskFolder {
  /** Directory name (slug) — what appears in URLs. */
  dir: string;
  /** Newest first. */
  issues: DiskIssue[];
}

/** A folder slug as it appears in a directory name and in URLs. */
export const DIR_NAME = /^[a-z0-9-]+$/;

/**
 * Scan the issue directory. Only `<slug>/<slug>-YYYY-MM-DD.mobi` regular files
 * are ever reported; anything else on disk (work dirs, thumbnails, symlinks,
 * stray files) is invisible. Returns undefined when the directory itself cannot
 * be read, so callers can tell "nothing there" from "could not look".
 */
export async function scanIssues(kindleDir: string): Promise<DiskFolder[] | undefined> {
  let dirs: string[];
  try {
    dirs = (await readdir(kindleDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && DIR_NAME.test(d.name))
      .map((d) => d.name);
  } catch {
    return undefined;
  }

  const folders: DiskFolder[] = [];
  for (const dir of dirs) {
    try {
      const issues = await listIssues(kindleDir, dir);
      if (issues.length > 0) folders.push({ dir, issues });
    } catch {
      // The folder vanished or is unreadable mid-scan; list the others.
    }
  }
  return folders;
}

async function listIssues(kindleDir: string, dir: string): Promise<DiskIssue[]> {
  // A symlinked directory would otherwise be followed out of KINDLE_DIR.
  if (!(await lstat(join(kindleDir, dir))).isDirectory()) return [];
  const issues: DiskIssue[] = [];
  for (const entry of await readdir(join(kindleDir, dir), { withFileTypes: true })) {
    const m = ISSUE_FILE.exec(entry.name);
    // Dirent.isFile() is false for symlinks, so links are never followed.
    if (!entry.isFile() || !m || m[1] !== dir) continue;
    try {
      issues.push({
        file: entry.name,
        date: m[2],
        bytes: (await stat(join(kindleDir, dir, entry.name))).size,
      });
    } catch {
      // Pruned between readdir and stat — it is simply no longer an issue.
    }
  }
  return issues.sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Resolve a requested file to a path on disk, or undefined if it is not a
 * published issue. The names must match strict patterns (no slashes, dots or
 * anything else that could leave the directory) and both the folder and the
 * file are checked with lstat, which does not follow symlinks.
 */
export async function resolveIssue(
  kindleDir: string,
  dir: string,
  file: string,
): Promise<{ path: string; bytes: number } | undefined> {
  const m = ISSUE_FILE.exec(file);
  if (!DIR_NAME.test(dir) || !m || m[1] !== dir) return undefined;
  try {
    if (!(await lstat(join(kindleDir, dir))).isDirectory()) return undefined;
    const st = await lstat(join(kindleDir, dir, file));
    return st.isFile() ? { path: join(kindleDir, dir, file), bytes: st.size } : undefined;
  } catch {
    return undefined;
  }
}
