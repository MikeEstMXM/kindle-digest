import { createHash } from 'node:crypto';

/** Filesystem-safe, lowercase slug of a folder name (used in EPUB paths). */
export function safeFolderName(folder: string): string {
  return folder.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

const MAX_SLUG = 60;

/**
 * Directory/file slug for a folder's published MOBIs. Like safeFolderName but
 * trimmed and bounded (long names would break URLs and filenames), and made
 * unique with a short hash when the slug would be lossy — a name with no ASCII
 * letters ("日本") or one that had to be truncated — so two such folders never
 * share a directory and overwrite each other's issues.
 */
export function issueSlug(folder: string): string {
  const base = safeFolderName(folder).replace(/^-+|-+$/g, '');
  const lossy = base === '' || base.length > MAX_SLUG || /[^ -~]/.test(folder);
  if (!lossy) return base;
  const hash = createHash('sha1').update(folder).digest('hex').slice(0, 6);
  return `${base.slice(0, MAX_SLUG).replace(/-+$/, '') || 'folder'}-${hash}`;
}
