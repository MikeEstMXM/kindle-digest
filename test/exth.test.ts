import { describe, it, expect } from 'vitest';
import { parseMobiExth, periodicalProblems } from '../src/mobi/exth.js';

/** A minimal MOBI header block: PalmDB header, record table, MOBI header, EXTH. */
function fakeMobi(records: [number, Buffer][]): Buffer {
  const exthBody = Buffer.concat(
    records.map(([type, data]) => {
      const h = Buffer.alloc(8);
      h.writeUInt32BE(type, 0);
      h.writeUInt32BE(8 + data.length, 4);
      return Buffer.concat([h, data]);
    }),
  );
  const exth = Buffer.concat([Buffer.from('EXTH'), Buffer.alloc(8), exthBody]);
  exth.writeUInt32BE(exth.length, 4);
  exth.writeUInt32BE(records.length, 8);

  const mobiLen = 0xe4;
  const mobi = Buffer.alloc(mobiLen);
  mobi.write('MOBI', 0, 'latin1');
  mobi.writeUInt32BE(mobiLen, 4);
  mobi.writeUInt32BE(0x40, 0x70); // has EXTH

  const rec0 = Buffer.concat([Buffer.alloc(16), mobi, exth]);
  const head = Buffer.alloc(90);
  head.writeUInt16BE(2, 76); // record count
  head.writeUInt32BE(90, 78); // record 0 offset
  head.writeUInt32BE(90 + rec0.length, 86); // record 1 offset
  return Buffer.concat([head, rec0]);
}

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

describe('parseMobiExth', () => {
  it('reads cde type, cover and updated title; no ASIN', () => {
    const exth = parseMobiExth(
      fakeMobi([
        [501, Buffer.from('NWPR')],
        [201, u32(7)],
        [503, Buffer.from('Technology')],
      ]),
    );
    expect(exth).toEqual({
      cdeType: 'NWPR',
      hasAsin: false,
      hasCover: true,
      updatedTitle: 'Technology',
    });
    expect(periodicalProblems(exth)).toEqual([]);
  });

  it('flags an ASIN (EXTH 113): the Kindle tile would lose its cover', () => {
    const exth = parseMobiExth(
      fakeMobi([
        [501, Buffer.from('NWPR')],
        [113, Buffer.from('B000000000')],
        [201, u32(7)],
      ]),
    );
    expect(periodicalProblems(exth).join()).toMatch(/ASIN/);
  });

  it('flags a plain book and a missing cover', () => {
    const problems = periodicalProblems(parseMobiExth(fakeMobi([[501, Buffer.from('EBOK')]])));
    expect(problems).toHaveLength(2);
    expect(problems.join()).toMatch(/EBOK/);
    expect(problems.join()).toMatch(/cover/);
  });

  it('rejects things that are not MOBI', () => {
    expect(() => parseMobiExth(Buffer.alloc(200))).toThrow();
    expect(() => parseMobiExth(Buffer.from('PK'))).toThrow();
  });
});
