import { OWNER_USER_ID, type DB } from './schema.js';

export interface IssueRow {
  id: number;
  /** Directory name under KINDLE_DIR; also what appears in URLs. */
  slug: string;
  /** The folder's real name, for display. */
  folder: string;
  /** ISO date. */
  issueDate: string;
  fileName: string;
  bytes: number;
}

export interface IssueFolder {
  slug: string;
  folder: string;
  count: number;
  latest: IssueRow;
}

export interface IssueInput {
  slug: string;
  folder: string;
  issueDate: string;
  fileName: string;
  bytes: number;
}

function mapIssue(r: Record<string, unknown>): IssueRow {
  return {
    id: r.id as number,
    slug: r.slug as string,
    folder: r.folder as string,
    issueDate: r.issue_date as string,
    fileName: r.file_name as string,
    bytes: r.bytes as number,
  };
}

/** The index of published issues (the .mobi files themselves live in KINDLE_DIR). */
export class IssueRepo {
  constructor(
    private db: DB,
    private userId: number = OWNER_USER_ID,
  ) {}

  /** Add an issue, or update it when the same date was published again. */
  record(i: IssueInput): void {
    this.db
      .prepare(
        `INSERT INTO issues (user_id, slug, folder, issue_date, file_name, bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, slug, issue_date) DO UPDATE SET
           folder = excluded.folder, file_name = excluded.file_name, bytes = excluded.bytes`,
      )
      .run(this.userId, i.slug, i.folder, i.issueDate, i.fileName, i.bytes, Date.now());
  }

  /** Drop index entries (the files are already gone, or never were). */
  forget(slug: string, fileNames: string[]): void {
    const del = this.db.prepare(
      'DELETE FROM issues WHERE user_id = ? AND slug = ? AND file_name = ?',
    );
    this.db.transaction(() => {
      for (const f of fileNames) del.run(this.userId, slug, f);
    })();
  }

  find(slug: string, fileName: string): IssueRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM issues WHERE user_id = ? AND slug = ? AND file_name = ?')
      .get(this.userId, slug, fileName) as Record<string, unknown> | undefined;
    return row ? mapIssue(row) : undefined;
  }

  /** Every issue of one folder, newest first. */
  list(slug: string): IssueRow[] {
    return (
      this.db
        .prepare('SELECT * FROM issues WHERE user_id = ? AND slug = ? ORDER BY issue_date DESC')
        .all(this.userId, slug) as Record<string, unknown>[]
    ).map(mapIssue);
  }

  all(): IssueRow[] {
    return (
      this.db
        .prepare('SELECT * FROM issues WHERE user_id = ? ORDER BY issue_date DESC, id DESC')
        .all(this.userId) as Record<string, unknown>[]
    ).map(mapIssue);
  }

  /** One entry per folder with its newest issue and issue count; most recently published first. */
  folders(): IssueFolder[] {
    const bySlug = new Map<string, IssueFolder>();
    for (const row of this.all()) {
      const seen = bySlug.get(row.slug);
      if (seen) seen.count += 1;
      else bySlug.set(row.slug, { slug: row.slug, folder: row.folder, count: 1, latest: row });
    }
    return [...bySlug.values()].sort(
      (a, b) =>
        b.latest.issueDate.localeCompare(a.latest.issueDate) || a.folder.localeCompare(b.folder),
    );
  }
}
