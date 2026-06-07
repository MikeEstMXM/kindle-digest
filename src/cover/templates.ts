import { escapeHtml } from '../util/html.js';
import type { TemplateId } from './hash.js';

export interface CoverData {
  folder: string;
  weekday: string; // largest text — the title
  isoDate: string; // 2026-06-07
  dateLabel: string; // human-readable, used in dividers
  feeds: { name: string; count: number }[];
  glyph: string;
  /** Relative href within the EPUB (e.g. images/cover.jpg), or undefined. */
  backgroundImageHref?: string;
}

export interface TemplatePieces {
  /** Template-specific CSS appended after the shared base CSS. */
  css: string;
  /** Inner HTML of .content, in fixed order incl. spacer. */
  contentHtml: string;
  /** Extra siblings inside .cover, above .content (e.g. Review borders). */
  decorationHtml: string;
}

const TEXT_SHADOW =
  'text-shadow: 0 1px 6px rgba(0,0,0,0.65), 0 0 14px rgba(0,0,0,0.35);';

function feedListHtml(feeds: CoverData['feeds']): string {
  const rows = feeds
    .map(
      (f) =>
        `      <li class="feed"><span class="feed-name">${escapeHtml(f.name)}</span>` +
        `<span class="feed-count">${f.count}</span></li>`,
    )
    .join('\n');
  return `<ul class="feed-list">\n${rows}\n    </ul>`;
}

function titleBlock(data: CoverData): string {
  // weekday (title) and folder (subtitle) are adjacent siblings — never split.
  return (
    `<div class="title-block">\n` +
    `      <div class="weekday">${escapeHtml(data.weekday)}</div>\n` +
    `      <div class="folder">${escapeHtml(data.folder)}</div>\n` +
    `    </div>`
  );
}

/** Shared base CSS for every template (layout, overlay host, feed list). */
export function sharedCss(): string {
  return `* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
.cover { width: 100%; aspect-ratio: 3 / 4; position: relative; overflow: hidden; background: #1a1a1a; }
img.bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.crosshatch { position: absolute; inset: 0; background-color: #1a1a1a;
  background-image:
    repeating-linear-gradient(45deg, rgba(255,255,255,0.06) 0, rgba(255,255,255,0.06) 1px, transparent 1px, transparent 7px),
    repeating-linear-gradient(-45deg, rgba(255,255,255,0.06) 0, rgba(255,255,255,0.06) 1px, transparent 1px, transparent 7px); }
.overlay { position: absolute; inset: 0; }
.content { position: absolute; inset: 0; display: flex; flex-direction: column; padding: 0; }
.content { ${TEXT_SHADOW} }
.header, .title-block, .divider, .feed-list { flex-shrink: 0; }
.spacer { flex: 1; }
.feed-list { list-style: none; margin: 0; max-width: 40%; }
.feed { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.feed-name { flex: 1; word-wrap: break-word; }
.feed-count { flex-shrink: 0; min-width: 16px; text-align: right; }`;
}

// ─── Templates ───────────────────────────────────────────────────────────────

function broadsheet(data: CoverData): TemplatePieces {
  const css = `.content { font-family: 'Playfair Display', Georgia, serif; }
.overlay { background: linear-gradient(to bottom,
    rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 30%, rgba(0,0,0,0.55) 65%, rgba(0,0,0,0.92) 100%); }
.header { background: #000; }
.band { display: flex; align-items: center; justify-content: space-between; padding: 14px 28px; }
.band .kicker { font-variant: small-caps; letter-spacing: 0.28em; font-size: 15px; color: #fff; }
.band .glyph { font-size: 20px; color: #fff; }
.triple-rule { background: #000; padding: 0 0 6px; }
.triple-rule div { background: #fff; }
.triple-rule .r1 { height: 3px; }
.triple-rule .r2 { height: 1px; margin-top: 2px; }
.triple-rule .r3 { height: 1px; margin-top: 2px; }
.title-block, .divider, .feed-list { padding-left: 28px; padding-right: 28px; }
.weekday { font-size: 84px; font-weight: 900; letter-spacing: -0.04em; color: #fff; line-height: 0.95; }
.folder { font-size: 20px; font-style: italic; color: rgba(255,255,255,0.72); margin-top: 6px; }
.divider { height: 1px; background: rgba(255,255,255,0.5); margin: 16px 28px; max-width: 40%; }
.feed-list { font-style: italic; font-size: 13px; color: #fff; padding-bottom: 28px; }`;
  const contentHtml =
    `<div class="header">\n` +
    `      <div class="band"><span class="kicker">DAILY DIGEST</span><span class="glyph">${data.glyph}</span></div>\n` +
    `      <div class="triple-rule"><div class="r1"></div><div class="r2"></div><div class="r3"></div></div>\n` +
    `    </div>\n` +
    `    <div class="spacer"></div>\n` +
    `    ${titleBlock(data)}\n` +
    `    <div class="divider"></div>\n` +
    `    ${feedListHtml(data.feeds)}`;
  return { css, contentHtml, decorationHtml: '' };
}

function theDrop(data: CoverData): TemplatePieces {
  const css = `.content { font-family: 'Bebas Neue', Impact, sans-serif; }
.overlay { background: linear-gradient(to bottom,
    rgba(0,0,0,0.65) 0%, rgba(0,0,0,0) 30%, rgba(0,0,0,0.60) 65%, rgba(0,0,0,0.96) 100%); }
.header { display: flex; align-items: flex-start; justify-content: space-between; padding: 24px 28px 0; }
.header .kicker { letter-spacing: 0.3em; font-size: 14px; color: rgba(255,255,255,0.5); }
.header .glyph { font-size: 18px; color: rgba(255,255,255,0.5); }
.title-block, .divider, .feed-list { padding-left: 28px; padding-right: 28px; }
.weekday { font-size: 118px; letter-spacing: 0.03em; text-transform: uppercase; color: #fff; line-height: 0.9; }
.folder { font-size: 17px; letter-spacing: 0.25em; text-transform: uppercase; color: rgba(255,255,255,0.65); margin-top: 8px; }
.divider { height: 1px; background: rgba(255,255,255,0.4); margin: 14px 28px; max-width: 40%; }
.feed-list { text-transform: uppercase; font-size: 10px; letter-spacing: 0.1em; color: #fff; padding-bottom: 30px; }`;
  const contentHtml =
    `<div class="header">\n` +
    `      <span class="kicker">DAILY DIGEST</span><span class="glyph">${data.glyph}</span>\n` +
    `    </div>\n` +
    `    <div class="spacer"></div>\n` +
    `    ${titleBlock(data)}\n` +
    `    <div class="divider"></div>\n` +
    `    ${feedListHtml(data.feeds)}`;
  return { css, contentHtml, decorationHtml: '' };
}

function theReview(data: CoverData): TemplatePieces {
  const css = `.content { font-family: 'EB Garamond', Garamond, serif; align-items: center; text-align: center; padding: 0 40px; }
.overlay { background: linear-gradient(to bottom,
    rgba(0,0,0,0.62) 0%, rgba(0,0,0,0) 35%, rgba(0,0,0,0.55) 65%, rgba(0,0,0,0.94) 100%); }
.header { padding-top: 30px; }
.header .kicker { letter-spacing: 0.35em; text-transform: uppercase; font-size: 13px; font-weight: 600; color: #fff; }
.header .glyph { display: block; font-size: 22px; margin-top: 10px; color: #fff; }
.header .rule { width: 56px; height: 1px; background: rgba(255,255,255,0.6); margin: 12px auto 0; }
.weekday { font-size: 66px; font-style: italic; letter-spacing: -0.02em; color: #fff; line-height: 1; }
.folder { font-size: 17px; font-style: italic; color: rgba(255,255,255,0.72); margin-top: 8px; }
.divider { letter-spacing: 0.5em; color: rgba(255,255,255,0.38); font-size: 18px; margin: 14px 0; }
.feed-list { font-style: italic; font-size: 12px; color: #fff; margin: 0 auto; padding-bottom: 34px; }
.border-outer, .border-inner { position: absolute; pointer-events: none; }
.border-outer { inset: 6px; border: 1px solid rgba(255,255,255,0.5); }
.border-inner { inset: 10px; border: 1px solid rgba(255,255,255,0.22); }`;
  const contentHtml =
    `<div class="header">\n` +
    `      <div class="kicker">Daily Digest</div>\n` +
    `      <span class="glyph">${data.glyph}</span>\n` +
    `      <div class="rule"></div>\n` +
    `    </div>\n` +
    `    <div class="spacer"></div>\n` +
    `    ${titleBlock(data)}\n` +
    `    <div class="divider">· · ·</div>\n` +
    `    ${feedListHtml(data.feeds)}`;
  // Borders sit above .content per spec (z-index handled by DOM order + style).
  const decorationHtml =
    `<div class="border-outer"></div>\n    <div class="border-inner"></div>`;
  return { css, contentHtml, decorationHtml };
}

function theSignal(data: CoverData): TemplatePieces {
  const css = `.content { font-family: 'Oswald', 'Arial Narrow', sans-serif; }
.overlay { background: linear-gradient(to bottom,
    rgba(0,0,0,0) 0%, rgba(0,0,0,0) 50%, rgba(0,0,0,0.55) 65%, rgba(0,0,0,0.95) 100%); }
.header { background: #000; display: flex; align-items: center; justify-content: space-between; padding: 14px 28px; }
.header .kicker { font-variant: small-caps; font-weight: 600; font-size: 15px; letter-spacing: 0.05em; color: #fff; }
.header .glyph { font-size: 20px; color: #fff; }
.accent { height: 4px; background: #555; }
.title-block, .feed-list { padding-left: 28px; padding-right: 28px; }
.weekday { font-size: 96px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.01em; color: #fff; line-height: 0.92; }
.folder { font-size: 17px; letter-spacing: 0.18em; text-transform: uppercase; color: rgba(255,255,255,0.65); margin-top: 8px; }
.divider { display: flex; align-items: center; gap: 12px; padding: 0 28px; margin: 14px 0; }
.divider .rule { flex: 1; height: 2px; background: rgba(255,255,255,0.7); }
.divider .date { letter-spacing: 0.18em; font-size: 13px; color: #fff; text-transform: uppercase; }
.feed-list { text-transform: uppercase; font-size: 11px; letter-spacing: 0.08em; color: #fff; padding-bottom: 30px; }`;
  const contentHtml =
    `<div class="header">\n` +
    `      <span class="kicker">DAILY DIGEST</span><span class="glyph">${data.glyph}</span>\n` +
    `    </div>\n` +
    `    <div class="accent"></div>\n` +
    `    <div class="spacer"></div>\n` +
    `    ${titleBlock(data)}\n` +
    `    <div class="divider"><span class="rule"></span><span class="date">${escapeHtml(
      data.dateLabel,
    )}</span><span class="rule"></span></div>\n` +
    `    ${feedListHtml(data.feeds)}`;
  return { css, contentHtml, decorationHtml: '' };
}

const RENDERERS: Record<TemplateId, (d: CoverData) => TemplatePieces> = {
  broadsheet,
  'the-drop': theDrop,
  'the-review': theReview,
  'the-signal': theSignal,
};

export function renderTemplate(id: TemplateId, data: CoverData): TemplatePieces {
  return RENDERERS[id](data);
}
