import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { FolderSettings } from '../db/feedRepos.js';
import type { IssueRepo } from '../db/issueRepo.js';
import { issueSlug } from '../util/folderName.js';
import { importIssue, type ImportResult } from './importIssue.js';

export const USAGE = `Usage:
  import-issue --folder <Folder> --date <YYYY-MM-DD> [--force] <file.epub | directory>
  import-issue [--force] --dir <directory>

Converts a past digest into a Kindle periodical MOBI under KINDLE_DIR with its
original date and adds it to /issues. Never sends mail or changes deliveries.
An issue that is already there is skipped unless --force is given.

  <directory>   an unpacked EPUB, or a build staging directory (art-N.xhtml pages)
  --dir         import every "<Folder>-<YYYY-MM-DD>.epub" and
                ".staging-<Folder>-<YYYY-MM-DD>" directory in it; the folder's
                real name (e.g. "Money") is taken from the app's own folders
`;

export interface CliDeps {
  kindleDir: string;
  ebookConvertBin: string;
  timeoutMs: number;
  issues: IssueRepo;
  /** Folder names the app knows (for --dir: "money" -> "Money"). */
  knownFolders: string[];
  coverSettings(folder: string): Pick<FolderSettings, 'coverTemplate' | 'coverTheme'>;
  fonts: { file: string; data: Buffer }[];
}

interface Job {
  folder: string;
  isoDate: string;
  source: string;
  label: string;
}

const BATCH_NAME = /^(?:\.staging-)?(.+)-(\d{4}-\d{2}-\d{2})(\.epub)?$/i;

const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MB`;

function describe(job: Job, r: ImportResult): string {
  const what = `${job.folder} ${job.isoDate}`;
  if (r.status === 'skipped') {
    return `skipped   ${what}  ${r.fileName} already exists (use --force to replace)${r.note ? `  [${r.note}]` : ''}`;
  }
  return `${r.status.padEnd(9)} ${what}  ${r.fileName} ${mb(r.bytes)}${r.note ? `  [${r.note}]` : ''}`;
}

/** Work out the jobs for `--dir`: what to import from a directory of recovered issues. */
async function jobsFromDir(dir: string, known: string[]): Promise<{ jobs: Job[]; problems: string[] }> {
  const byName = new Map(known.map((f) => [issueSlug(f), f]));
  const jobs: Job[] = [];
  const problems: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const isStaging = e.isDirectory() && e.name.startsWith('.staging-');
    const isEpub = e.isFile() && /\.epub$/i.test(e.name);
    if (!isStaging && !isEpub) continue; // *.azw3 and anything else is not an issue
    const m = BATCH_NAME.exec(e.name);
    if (!m) {
      problems.push(`skipped   ${e.name}  name is not <Folder>-<YYYY-MM-DD>`);
      continue;
    }
    const folder = byName.get(issueSlug(m[1]));
    if (!folder) {
      problems.push(`failed    ${e.name}  unknown folder "${m[1]}" (known: ${known.join(', ') || 'none'}); import it with --folder`);
      continue;
    }
    jobs.push({ folder, isoDate: m[2], source: join(dir, e.name), label: e.name });
  }
  jobs.sort((a, b) => a.isoDate.localeCompare(b.isoDate) || a.folder.localeCompare(b.folder));
  return { jobs, problems };
}

/**
 * Run the importer. Prints one line per issue and returns the exit code:
 * 0 everything imported or skipped, 1 something failed, 2 bad usage.
 */
export async function runCli(
  argv: string[],
  deps: CliDeps,
  out: (line: string) => void = console.log,
): Promise<number> {
  let values: { folder?: string; date?: string; dir?: string; force?: boolean; help?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        folder: { type: 'string' },
        date: { type: 'string' },
        dir: { type: 'string' },
        force: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (err) {
    out(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    out(USAGE);
    return 0;
  }

  let jobs: Job[];
  let failures = 0;
  if (values.dir) {
    if (values.folder || values.date || positionals.length > 0) {
      out(`--dir cannot be combined with --folder, --date or a path\n${USAGE}`);
      return 2;
    }
    let found;
    try {
      found = await jobsFromDir(values.dir, deps.knownFolders);
    } catch (err) {
      out(`failed    ${values.dir}  ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    jobs = found.jobs;
    for (const p of found.problems) {
      out(p);
      if (p.startsWith('failed')) failures += 1;
    }
  } else {
    if (!values.folder || !values.date || positionals.length !== 1) {
      out(`Need --folder, --date and exactly one path.\n${USAGE}`);
      return 2;
    }
    // The app's own spelling of the folder wins ("money" -> "Money"): it is what
    // /issues shows and what the cover settings are keyed by.
    const known = new Map(deps.knownFolders.map((f) => [issueSlug(f), f]));
    jobs = [
      {
        folder: known.get(issueSlug(values.folder)) ?? values.folder,
        isoDate: values.date,
        source: positionals[0],
        label: positionals[0],
      },
    ];
  }

  for (const job of jobs) {
    try {
      const cover = deps.coverSettings(job.folder);
      const result = await importIssue({
        folder: job.folder,
        isoDate: job.isoDate,
        source: job.source,
        force: values.force === true,
        kindleDir: deps.kindleDir,
        issues: deps.issues,
        ebookConvertBin: deps.ebookConvertBin,
        timeoutMs: deps.timeoutMs,
        coverTemplate: cover.coverTemplate,
        coverTheme: cover.coverTheme,
        fonts: deps.fonts,
      });
      out(describe(job, result));
    } catch (err) {
      failures += 1;
      const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
      out(`failed    ${job.folder} ${job.isoDate}  ${job.label}: ${msg}`);
    }
  }
  if (jobs.length === 0 && failures === 0) out('nothing to import');
  return failures > 0 ? 1 : 0;
}
