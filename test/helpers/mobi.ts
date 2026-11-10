import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

/**
 * A small but structurally real .mobi: PalmDB header, record 0 (PalmDOC header,
 * MOBI header, EXTH with periodical type / title / cover offset), a text record
 * and — when given — a cover image record that EXTH 201 points at.
 */
export function buildMobi(opts: { title?: string; cover?: Buffer; body?: string } = {}): Buffer {
  const exthRecords: [number, Buffer][] = [[501, Buffer.from('NWPR')]];
  if (opts.title) exthRecords.push([503, Buffer.from(opts.title)]);
  if (opts.cover) exthRecords.push([201, u32(0)]); // 0 = the first image record
  const body = Buffer.concat(
    exthRecords.map(([type, data]) => Buffer.concat([u32(type), u32(8 + data.length), data])),
  );
  const exth = Buffer.concat([
    Buffer.from('EXTH'),
    u32(12 + body.length),
    u32(exthRecords.length),
    body,
  ]);

  const mobi = Buffer.alloc(0xe8);
  mobi.write('MOBI', 0, 'latin1');
  mobi.writeUInt32BE(mobi.length, 4);
  mobi.writeUInt32BE(2, 0x5c); // first image record
  mobi.writeUInt32BE(0x40, 0x70); // has EXTH

  const records = [
    Buffer.concat([Buffer.alloc(16), mobi, exth]),
    Buffer.from(opts.body ?? 'text'),
    ...(opts.cover ? [opts.cover] : [Buffer.from('no-image')]),
  ];
  const tableEnd = 78 + 8 * records.length + 2;
  const head = Buffer.alloc(tableEnd);
  head.writeUInt16BE(records.length, 76);
  let offset = tableEnd;
  records.forEach((r, i) => {
    head.writeUInt32BE(offset, 78 + 8 * i);
    offset += r.length;
  });
  return Buffer.concat([head, ...records]);
}

/** A throwaway KINDLE_DIR laid out like the real one, plus things that must stay invisible. */
export async function makeKindleDir(): Promise<{
  root: string;
  kindleDir: string;
  cleanup(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'kd-archive-'));
  const kindleDir = join(root, 'kindle');
  await mkdir(join(kindleDir, 'news'), { recursive: true });
  await mkdir(join(kindleDir, 'tech'), { recursive: true });
  await mkdir(join(kindleDir, '.work', 'news-abc'), { recursive: true });
  await writeFile(join(kindleDir, 'news', 'news-2026-11-09.mobi'), 'OLD-ISSUE');
  await writeFile(join(kindleDir, 'news', 'news-2026-11-10.mobi'), 'NEW-ISSUE');
  await writeFile(join(kindleDir, 'tech', 'tech-2026-11-08.mobi'), 'TECH-ISSUE');
  // Things that must stay invisible.
  await writeFile(join(kindleDir, 'news', 'notes.txt'), 'private');
  await writeFile(join(kindleDir, 'news', 'news-2026-11-10.epub'), 'epub');
  await writeFile(join(kindleDir, '.work', 'news-abc', 'out.mobi'), 'half-written');
  await writeFile(join(root, 'secret.mobi'), 'OUTSIDE');
  await symlink(join(root, 'secret.mobi'), join(kindleDir, 'news', 'news-2026-11-11.mobi'));
  await writeFile(join(kindleDir, 'top-level-2026-11-10.mobi'), 'not in a folder');
  // A symlinked *directory* pointing outside the archive.
  await mkdir(join(root, 'outside'), { recursive: true });
  await writeFile(join(root, 'outside', 'evil-2026-11-10.mobi'), 'OUTSIDE-DIR');
  await symlink(join(root, 'outside'), join(kindleDir, 'evil'));
  return { root, kindleDir, cleanup: () => rm(root, { recursive: true, force: true }) };
}
