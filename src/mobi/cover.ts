import { open } from 'node:fs/promises';
import sharp from 'sharp';

/**
 * Pull the cover image out of a .mobi, for the archive's thumbnails.
 *
 * MOBI is a PalmDB file: a record table, then record 0 (headers + EXTH), then
 * the text and image records. The MOBI header says where the images start
 * (offset 0x5C = "first image index") and EXTH 201 says which of them is the
 * cover, as an offset from that first image. Only the header record and the
 * one cover record are read — never the whole book.
 */

const EXTH_COVER_OFFSET = 201;
const MAX_HEADER_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

export async function readMobiCover(path: string): Promise<Buffer | undefined> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const top = Buffer.alloc(78);
    await fh.read(top, 0, 78, 0);
    const count = top.readUInt16BE(76);
    if (count < 2) return undefined;

    const table = Buffer.alloc(8 * count);
    await fh.read(table, 0, table.length, 78);
    const offsetOf = (i: number): number => (i < count ? table.readUInt32BE(8 * i) : size);

    // Record 0: 16-byte PalmDOC header, then the MOBI header, then EXTH.
    const start = offsetOf(0);
    const rec0Len = Math.min(offsetOf(1) - start, MAX_HEADER_BYTES);
    if (rec0Len < 16 + 0x74) return undefined;
    const rec0 = Buffer.alloc(rec0Len);
    await fh.read(rec0, 0, rec0Len, start);

    const mobi = 16;
    if (rec0.toString('latin1', mobi, mobi + 4) !== 'MOBI') return undefined;
    const headerLen = rec0.readUInt32BE(mobi + 4);
    const firstImage = rec0.readUInt32BE(mobi + 0x5c);
    const hasExth = (rec0.readUInt32BE(mobi + 0x70) & 0x40) !== 0;
    const exth = mobi + headerLen;
    if (!hasExth || rec0.toString('latin1', exth, exth + 4) !== 'EXTH') return undefined;

    let coverOffset: number | undefined;
    const records = rec0.readUInt32BE(exth + 8);
    let p = exth + 12;
    for (let i = 0; i < records && p + 8 <= rec0.length; i++) {
      const type = rec0.readUInt32BE(p);
      const len = rec0.readUInt32BE(p + 4);
      if (len < 8) return undefined;
      if (type === EXTH_COVER_OFFSET && len >= 12) coverOffset = rec0.readUInt32BE(p + 8);
      p += len;
    }
    if (coverOffset === undefined) return undefined;

    const index = firstImage + coverOffset;
    if (firstImage === 0 || index >= count) return undefined;
    const imgStart = offsetOf(index);
    const imgLen = offsetOf(index + 1) - imgStart;
    if (imgLen <= 0 || imgLen > MAX_IMAGE_BYTES) return undefined;
    const img = Buffer.alloc(imgLen);
    await fh.read(img, 0, imgLen, imgStart);
    return img;
  } finally {
    await fh.close();
  }
}

/** The cover as a small JPEG for the archive list; undefined if there is none. */
export async function mobiThumbnail(path: string, width = 120): Promise<Buffer | undefined> {
  const cover = await readMobiCover(path);
  if (!cover) return undefined;
  try {
    return await sharp(cover)
      .resize({ width, withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toBuffer();
  } catch {
    return undefined; // not an image we can decode
  }
}
