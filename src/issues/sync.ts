import { join } from 'node:path';
import type { IssueRepo } from '../db/issueRepo.js';
import { readMobiExth } from '../mobi/exth.js';
import { issueSlug } from '../util/folderName.js';
import { scanIssues } from './scan.js';

/**
 * Make the issue index match the files in KINDLE_DIR. Run at startup so issues
 * published before the archive existed (or copied in by hand) show up.
 *
 * Adds and updates every issue on disk, and forgets index entries whose file is
 * gone — but only when the directory was actually readable, so an unmounted
 * volume cannot wipe the index.
 *
 * `folderNames` are the real folder names, used to turn a directory slug back
 * into a title; failing that the MOBI's own title is used, then the slug.
 */
export async function syncIssues(
  repo: IssueRepo,
  kindleDir: string,
  folderNames: string[],
): Promise<{ added: number; removed: number }> {
  const disk = await scanIssues(kindleDir);
  if (!disk) return { added: 0, removed: 0 };

  const known = new Map(repo.all().map((i) => [`${i.slug}/${i.fileName}`, i]));
  const names = new Map<string, string>();
  for (const f of folderNames) names.set(issueSlug(f), f);
  for (const i of known.values()) if (!names.has(i.slug)) names.set(i.slug, i.folder);

  let added = 0;
  const onDisk = new Set<string>();
  for (const dir of disk) {
    for (const issue of dir.issues) {
      onDisk.add(`${dir.dir}/${issue.file}`);
      const have = known.get(`${dir.dir}/${issue.file}`);
      if (have && have.bytes === issue.bytes) continue;
      let folder = names.get(dir.dir);
      if (!folder) {
        folder = await titleOf(join(kindleDir, dir.dir, issue.file), dir.dir);
        names.set(dir.dir, folder);
      }
      repo.record({
        slug: dir.dir,
        folder,
        issueDate: issue.date,
        fileName: issue.file,
        bytes: issue.bytes,
      });
      if (!have) added += 1;
    }
  }

  let removed = 0;
  for (const [key, i] of known) {
    if (onDisk.has(key)) continue;
    repo.forget(i.slug, [i.fileName]);
    removed += 1;
  }
  return { added, removed };
}

async function titleOf(path: string, slug: string): Promise<string> {
  try {
    return (await readMobiExth(path)).updatedTitle ?? slug;
  } catch {
    return slug;
  }
}
