import { open } from 'node:fs/promises';

/**
 * Minimal MOBI/EXTH header reader. Used to verify that a calibre conversion
 * really is a Kindle periodical before it is published, and by the tests.
 * Only the first record (headers) is parsed; the book body is never loaded.
 *
 * Layout: PalmDB header (record count at 76, record table from 78, 8 bytes per
 * entry) → record 0 = 16-byte PalmDOC header, MOBI header, EXTH block.
 */

export const EXTH_ASIN = 113;
export const EXTH_COVER_OFFSET = 201;
export const EXTH_CDE_TYPE = 501;
export const EXTH_UPDATED_TITLE = 503;

export interface MobiExth {
  /** EXTH 501, e.g. "NWPR" (periodical), "EBOK" (book), "MAGZ". */
  cdeType?: string;
  /** EXTH 113 present — the Kindle will not show a cover thumbnail with it. */
  hasAsin: boolean;
  /** EXTH 201 present — the cover image is embedded. */
  hasCover: boolean;
  /** EXTH 503 */
  updatedTitle?: string;
}

export function parseMobiExth(head: Buffer): MobiExth {
  if (head.length < 90) throw new Error('not a MOBI file (too short)');
  const rec0 = head.readUInt32BE(78);
  const mobi = rec0 + 16;
  if (head.toString('latin1', mobi, mobi + 4) !== 'MOBI') throw new Error('no MOBI header');
  const headerLen = head.readUInt32BE(mobi + 4);
  const hasExth = (head.readUInt32BE(mobi + 0x70) & 0x40) !== 0;
  const exth = mobi + headerLen;
  if (!hasExth || head.toString('latin1', exth, exth + 4) !== 'EXTH')
    throw new Error('no EXTH block');

  const count = head.readUInt32BE(exth + 8);
  const out: MobiExth = { hasAsin: false, hasCover: false };
  let p = exth + 12;
  for (let i = 0; i < count; i++) {
    const type = head.readUInt32BE(p);
    const len = head.readUInt32BE(p + 4);
    if (len < 8) throw new Error('corrupt EXTH record');
    const data = head.subarray(p + 8, p + len);
    if (type === EXTH_ASIN) out.hasAsin = true;
    else if (type === EXTH_COVER_OFFSET) out.hasCover = true;
    else if (type === EXTH_CDE_TYPE) out.cdeType = data.toString('latin1');
    else if (type === EXTH_UPDATED_TITLE) out.updatedTitle = data.toString('utf8');
    p += len;
  }
  return out;
}

/** Read only the header records of a .mobi on disk. */
export async function readMobiExth(path: string): Promise<MobiExth> {
  const fh = await open(path, 'r');
  try {
    const table = Buffer.alloc(90);
    await fh.read(table, 0, 90, 0);
    // Record 1 starts where record 0 (all the headers) ends.
    const end = Math.min(table.readUInt32BE(86), 4 * 1024 * 1024);
    const head = Buffer.alloc(Math.max(end, 90));
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    return parseMobiExth(head.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

/**
 * What the Kindle needs to stack issues and show a cover on the tile (verified
 * on a Kindle 11th gen): periodical type, no ASIN, embedded cover.
 * Returns the list of problems; empty means good.
 */
export function periodicalProblems(exth: MobiExth): string[] {
  const problems: string[] = [];
  if (exth.cdeType !== 'NWPR')
    problems.push(`EXTH 501 is ${exth.cdeType ?? 'missing'}, expected NWPR`);
  if (exth.hasAsin) problems.push('EXTH 113 (ASIN) is present; the tile would have no cover');
  if (!exth.hasCover) problems.push('EXTH 201 (cover) is missing');
  return problems;
}
