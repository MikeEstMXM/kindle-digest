/** Filesystem-safe, lowercase slug of a folder name (used in EPUB and MOBI paths). */
export function safeFolderName(folder: string): string {
  return folder.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}
