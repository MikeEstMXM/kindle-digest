import type { NormalizedArticle } from '../inoreader/types.js';

export interface FolderGroup {
  folder: string;
  articles: NormalizedArticle[];
}

/**
 * Group a flat article list by top-level folder, dropping any whose item id is
 * in the excluded set. Folders left with zero included articles are omitted.
 * Folder order is preserved by first appearance, then sorted alphabetically.
 */
export function groupIncludedByFolder(
  articles: (NormalizedArticle & { folder: string })[],
  excludedIds: Set<string>,
): FolderGroup[] {
  const byFolder = new Map<string, NormalizedArticle[]>();
  for (const a of articles) {
    if (excludedIds.has(a.itemId)) continue;
    if (!byFolder.has(a.folder)) byFolder.set(a.folder, []);
    byFolder.get(a.folder)!.push(a);
  }
  return [...byFolder.entries()]
    .filter(([, list]) => list.length > 0)
    .map(([folder, list]) => ({ folder, articles: list }))
    .sort((x, y) => x.folder.localeCompare(y.folder));
}

/** Feed name + article-count rows for a folder's cover, sorted by count desc. */
export function feedCounts(articles: NormalizedArticle[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const a of articles) {
    counts.set(a.feedTitle, (counts.get(a.feedTitle) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
