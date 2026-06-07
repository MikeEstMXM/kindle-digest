import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM encryption for OAuth tokens at rest. The key comes from
 * CREDENTIAL_ENCRYPTION_KEY (32 bytes, supplied as 64 hex chars or base64).
 * Ciphertext is stored as `iv:authTag:data`, all base64.
 */

export function parseKey(raw: string): Buffer {
  const trimmed = raw.trim();
  // 64 hex chars => 32 bytes
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  const buf = Buffer.from(trimmed, 'base64');
  if (buf.length !== 32) {
    throw new Error(
      'CREDENTIAL_ENCRYPTION_KEY must decode to 32 bytes (64 hex chars or base64). ' +
        'Generate one with: openssl rand -hex 32',
    );
  }
  return buf;
}

export function encrypt(plaintext: string, keyRaw: string): string {
  const key = parseKey(keyRaw);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), data.toString('base64')].join(':');
}

export function decrypt(payload: string, keyRaw: string): string {
  const key = parseKey(keyRaw);
  const [ivB64, tagB64, dataB64] = payload.split(':');
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error('Malformed encrypted payload');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const out = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]);
  return out.toString('utf8');
}
