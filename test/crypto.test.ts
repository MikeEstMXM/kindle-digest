import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encrypt, decrypt, parseKey } from '../src/config/crypto.js';

const KEY_HEX = randomBytes(32).toString('hex');

describe('token encryption (AES-256-GCM)', () => {
  it('round-trips secrets', () => {
    const secret = 'oauth-refresh-token-abc123';
    const enc = encrypt(secret, KEY_HEX);
    expect(enc).not.toContain(secret);
    expect(decrypt(enc, KEY_HEX)).toBe(secret);
  });

  it('accepts hex or base64 keys of 32 bytes', () => {
    expect(parseKey(KEY_HEX).length).toBe(32);
    const b64 = randomBytes(32).toString('base64');
    expect(parseKey(b64).length).toBe(32);
  });

  it('rejects wrong-length keys', () => {
    expect(() => parseKey('tooshort')).toThrow();
  });

  it('fails authentication with the wrong key', () => {
    const enc = encrypt('secret', KEY_HEX);
    expect(() => decrypt(enc, randomBytes(32).toString('hex'))).toThrow();
  });
});
