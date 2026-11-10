import { lstat, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { IssueRepo } from '../db/issueRepo.js';
import type { TemplateId } from '../cover/hash.js';
import { publishIssue } from '../mobi/publish.js';
import { issueSlug } from '../util/folderName.js';
import { buildEpubFromStaging, classifyDir, ImportSourceError, zipEpubDir } from './staging.js';

export interface ImportOptions {
  /** The folder's real name ("Money"); the archive directory and file names are derived from it. */
  folder: string;
  /** The issue's original date, YYYY-MM-DD. */
  isoDate: string;
  /** A digest .epub, an unpacked EPUB directory, or a build staging directory. */
  source: string;
  /** Replace an issue that is already there. */
  force: boolean;
  kindleDir: string;
  issues: IssueRepo;
  ebookConvertBin: string;
  timeoutMs: number;
  /** Cover look and fonts for a rebuilt staging directory (a finished EPUB already has its own). */
  coverTemplate?: TemplateId | null;
  coverTheme?: 'light' | 'dark';
  fonts?: { file: string; data: Buffer }[];
}

export interface ImportResult {
  status: 'imported' | 'replaced' | 'skipped';
  fileName: string;
  /** Size of the MOBI (the existing one when skipped). */
  bytes: number;
  /** Extra facts worth one line, e.g. what a staging rebuild had to leave out. */
  note?: string;
}

export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Bring one past issue into the archive: convert it to a Kindle periodical
 * with the same pipeline a live delivery uses, file it as
 * <KINDLE_DIR>/<slug>/<slug>-<original date>.mobi, and add it to the /issues
 * index. It never sends mail, never touches delivery rows or articles, and
 * never prunes other issues. An issue already on disk is left alone unless
 * `force` is set.
 */
export async function importIssue(opts: ImportOptions): Promise<ImportResult> {
  const folder = opts.folder.trim();
  if (!folder) throw new ImportSourceError('folder name is empty');
  if (!isIsoDate(opts.isoDate)) throw new ImportSourceError(`"${opts.isoDate}" is not a date (YYYY-MM-DD)`);

  const slug = issueSlug(folder);
  const fileName = `${slug}-${opts.isoDate}.mobi`;
  const finalPath = join(opts.kindleDir, slug, fileName);

  // The file on disk is the truth; the index is rebuilt from it.
  const existing = await lstat(finalPath).catch(() => undefined);
  if (existing?.isFile() && !opts.force) {
    // Nothing is converted, but an issue that is on disk and missing from the
    // index (copied in by hand, or a crash between the rename and the record)
    // would stay invisible until the next app restart, so index it now.
    const indexed = opts.issues.find(slug, fileName);
    if (!indexed || indexed.bytes !== existing.size) {
      opts.issues.record({
        slug,
        folder,
        issueDate: opts.isoDate,
        fileName,
        bytes: existing.size,
      });
    }
    return {
      status: 'skipped',
      fileName,
      bytes: existing.size,
      note: indexed && indexed.bytes === existing.size ? undefined : 'added to the index',
    };
  }

  const src = await stat(opts.source).catch(() => undefined);
  if (!src) throw new ImportSourceError(`${opts.source} does not exist`);

  await mkdir(join(opts.kindleDir, '.work'), { recursive: true });
  const work = await mkdtemp(join(opts.kindleDir, '.work', 'import-'));
  try {
    let epubPath = opts.source;
    let note: string | undefined;
    if (src.isDirectory()) {
      epubPath = join(work, 'source.epub');
      if ((await classifyDir(opts.source)) === 'epub') {
        await zipEpubDir(opts.source, epubPath);
      } else {
        const r = await buildEpubFromStaging(opts.source, epubPath, {
          folder,
          isoDate: opts.isoDate,
          coverTemplate: opts.coverTemplate,
          coverTheme: opts.coverTheme,
          fonts: opts.fonts,
          scratchDir: work,
        });
        note = `rebuilt from staging: ${r.articles} articles`;
        if (r.missingArticles.length > 0) note += `, ${r.missingArticles.length} missing pages`;
        if (r.droppedImages > 0) note += `, ${r.droppedImages} missing images dropped`;
      }
    } else if (!src.isFile()) {
      throw new ImportSourceError(`${opts.source} is not a file or directory`);
    }

    const published = await publishIssue({
      epubPath,
      folder,
      isoDate: opts.isoDate,
      kindleDir: opts.kindleDir,
      keepIssues: 0, // backfill never deletes anything
      ebookConvertBin: opts.ebookConvertBin,
      timeoutMs: opts.timeoutMs,
    });
    opts.issues.record({
      slug: published.slug,
      folder,
      issueDate: opts.isoDate,
      fileName: published.fileName,
      bytes: published.bytes,
    });
    return {
      status: existing ? 'replaced' : 'imported',
      fileName: published.fileName,
      bytes: published.bytes,
      note,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
