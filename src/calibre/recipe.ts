import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { escapeHtml } from '../util/html.js';

export interface CalibreArticle {
  title: string;
  feedTitle: string;
  url: string;
  author?: string;
  publishedMs?: number;
  bodyHtml: string;
}

export interface RecipeInput {
  folder: string;
  isoDate: string;
  dateLabel: string;
  articles: CalibreArticle[];
}

/**
 * Write a temp directory containing article HTML files, manifest.json,
 * cover.jpg, masthead.jpg, and digest.recipe for ebook-convert.
 * Returns the path to the directory (caller passes it to buildCalibreEpub).
 */
export function buildRecipeDir(
  input: RecipeInput,
  coverJpeg: Buffer,
  mastheadJpeg: Buffer,
): string {
  const dir = join(tmpdir(), `kindle-digest-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });

  // Group articles by feed → sections (preserving input order)
  const sectionMap = new Map<string, CalibreArticle[]>();
  for (const art of input.articles) {
    if (!sectionMap.has(art.feedTitle)) sectionMap.set(art.feedTitle, []);
    sectionMap.get(art.feedTitle)!.push(art);
  }

  // Write one HTML file per article; build manifest sections
  const sections: {
    name: string;
    articles: { title: string; url: string; date: string; author: string }[];
  }[] = [];
  let artIdx = 0;
  for (const [feedTitle, arts] of sectionMap) {
    const artManifest: { title: string; url: string; date: string; author: string }[] = [];
    for (const art of arts) {
      artIdx += 1;
      const htmlPath = join(dir, `art-${artIdx}.html`);
      const dateStr = art.publishedMs
        ? new Date(art.publishedMs).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          })
        : input.dateLabel;
      writeFileSync(htmlPath, buildArticleHtml(art, dateStr), 'utf-8');
      artManifest.push({
        title: art.title,
        url: `file://${htmlPath}`,
        date: dateStr,
        author: art.author ?? '',
      });
    }
    sections.push({ name: feedTitle, articles: artManifest });
  }

  // Write assets
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ folder: input.folder, date: input.isoDate, sections }, null, 2),
    'utf-8',
  );
  writeFileSync(join(dir, 'cover.jpg'), coverJpeg);
  writeFileSync(join(dir, 'masthead.jpg'), mastheadJpeg);
  writeFileSync(
    join(dir, 'digest.recipe'),
    buildRecipePython(join(dir, 'manifest.json'), join(dir, 'masthead.jpg')),
    'utf-8',
  );

  return dir;
}

function buildArticleHtml(art: CalibreArticle, dateStr: string): string {
  const metaParts = [art.feedTitle, art.author, dateStr].filter(Boolean).join(' · ');
  // Strip unresolved %%img-N%% placeholder tags left by sanitize.ts
  const cleanBody = art.bodyHtml.replace(/<img\b[^>]*%%img-\d+%%[^>]*\/>/g, '');
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${escapeHtml(art.title)}</title></head>
<body>
<h1>${escapeHtml(art.title)}</h1>
<p class="article-meta">${escapeHtml(metaParts)}</p>
<div class="article-body">${cleanBody}</div>
<p class="source-url"><small>Source: ${escapeHtml(art.url)}</small></p>
</body>
</html>`;
}

function buildRecipePython(manifestPath: string, mastheadPath: string): string {
  return `import json
from calibre.web.feeds.news import BasicNewsRecipe

_MANIFEST = json.load(open(${JSON.stringify(manifestPath)}))

class KindleDigest(BasicNewsRecipe):
    title             = _MANIFEST['folder']
    __author__        = 'Kindle Digest'
    publication_type  = 'magazine'
    masthead_url      = r'${mastheadPath}'
    oldest_article    = 7
    max_articles_per_feed = 200
    no_stylesheets    = True
    auto_cleanup      = False
    remove_javascript = True

    def parse_index(self):
        sections = []
        for section in _MANIFEST['sections']:
            arts = [
                {
                    'title':  a['title'],
                    'url':    a['url'],
                    'date':   a.get('date', ''),
                    'author': a.get('author', ''),
                }
                for a in section['articles']
            ]
            sections.append((section['name'], arts))
        return sections
`;
}
