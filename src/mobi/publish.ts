import { mkdir, mkdtemp, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { issueSlug } from '../util/folderName.js';
import { PermanentConversionError, runEbookConvert, writePeriodicalEpub } from './convert.js';
import { periodicalProblems, readMobiExth } from './exth.js';

export interface PublishOptions {
  /** The EPUB the app built (left untouched). */
  epubPath: string;
  folder: string;
  isoDate: string;
  /** Root of the Kindle page's files: <kindleDir>/<folder-slug>/<slug>-<date>.mobi */
  kindleDir: string;
  keepIssues: number;
  ebookConvertBin: string;
  timeoutMs: number;
}

export interface PublishedIssue {
  mobiPath: string;
  bytes: number;
}

/** `<slug>-YYYY-MM-DD.mobi` — the only filenames the Kindle page will ever list or serve. */
export const ISSUE_FILE = /^([a-z0-9-]+)-(\d{4}-\d{2}-\d{2})\.mobi$/;

/**
 * Convert one built EPUB into a periodical MOBI and put it where the Kindle
 * page serves it, then prune old issues. The file appears atomically (rename
 * from a work dir on the same volume) so the Kindle never downloads a
 * half-written issue, and a MOBI that is not a proper periodical is rejected
 * rather than published.
 */
export async function publishIssue(opts: PublishOptions): Promise<PublishedIssue> {
  const slug = issueSlug(opts.folder);
  const folderDir = join(opts.kindleDir, slug);
  const fileName = `${slug}-${opts.isoDate}.mobi`;
  const finalPath = join(folderDir, fileName);
  await mkdir(folderDir, { recursive: true });

  // Dot-prefixed, so the Kindle page can never list it.
  const workRoot = join(opts.kindleDir, '.work');
  await mkdir(workRoot, { recursive: true });
  const work = await mkdtemp(join(workRoot, `${slug}-`));
  try {
    const convEpub = join(work, 'in.epub');
    const outMobi = join(work, 'out.mobi');
    await writePeriodicalEpub(opts.epubPath, convEpub, opts.folder);
    await runEbookConvert(convEpub, outMobi, {
      bin: opts.ebookConvertBin,
      timeoutMs: opts.timeoutMs,
    });

    const problems = periodicalProblems(await readMobiExth(outMobi));
    if (problems.length > 0) {
      throw new PermanentConversionError(`not a Kindle periodical: ${problems.join('; ')}`);
    }

    await rename(outMobi, finalPath);
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  const bytes = (await stat(finalPath)).size;
  // Best effort: the issue is already live, so a pruning hiccup must not turn a
  // successful publish into a "failed" delivery.
  try {
    await pruneIssues(folderDir, slug, opts.keepIssues, fileName);
  } catch (err) {
    console.error(`[kindle] could not prune old ${slug} issues:`, err);
  }
  return { mobiPath: finalPath, bytes };
}

/** Remove conversion leftovers from a previous process that was killed mid-run. */
export async function clearWorkDir(kindleDir: string): Promise<void> {
  await rm(join(kindleDir, '.work'), { recursive: true, force: true });
}

/**
 * Delete all but the newest `keep` issues of one folder. `protect` (the issue
 * just published) is never deleted, even if it is older than the rest — e.g. a
 * re-run of an old date.
 */
export async function pruneIssues(
  folderDir: string,
  slug: string,
  keep: number,
  protect?: string,
): Promise<string[]> {
  const kept = Number.isFinite(keep) ? Math.max(1, Math.floor(keep)) : 7;
  const issues = (await readdir(folderDir))
    .map((name) => ISSUE_FILE.exec(name))
    .filter((m): m is RegExpExecArray => m !== null && m[1] === slug)
    .sort((a, b) => b[2].localeCompare(a[2]));
  const removed: string[] = [];
  for (const m of issues.slice(kept)) {
    if (m[0] === protect) continue;
    await unlink(join(folderDir, m[0]));
    removed.push(m[0]);
  }
  return removed;
}
