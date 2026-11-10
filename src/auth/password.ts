import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password hashing with scrypt (built into Node, memory-hard). The stored form
 * carries its own parameters — `scrypt$N$r$p$salt$hash` — so the cost can be
 * raised later and old hashes still verify.
 */

export interface ScryptCost {
  N: number;
  r: number;
  p: number;
}

/** 64 MB of memory and a couple of hundred ms per guess: OWASP's scrypt guidance. */
export const DEFAULT_COST: ScryptCost = { N: 2 ** 16, r: 8, p: 1 };

const KEY_LEN = 32;
const SALT_LEN = 16;

export const MIN_PASSWORD_LENGTH = 12;
/** Upper bound only so a huge request body cannot be used to burn CPU. */
export const MAX_PASSWORD_LENGTH = 256;

function derive(password: string, salt: Buffer, cost: ScryptCost): Promise<Buffer> {
  const opts: ScryptOptions = {
    N: cost.N,
    r: cost.r,
    p: cost.p,
    maxmem: 128 * cost.N * cost.r + 1024 * 1024,
  };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_LEN, opts, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(
  password: string,
  cost: ScryptCost = DEFAULT_COST,
): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await derive(password, salt, cost);
  return ['scrypt', cost.N, cost.r, cost.p, salt.toString('base64'), key.toString('base64')].join(
    '$',
  );
}

/** True only for a well-formed hash that the password matches. Never throws. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, n, r, p, salt, hash] = stored.split('$');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const cost = { N: Number(n), r: Number(r), p: Number(p) };
    if (![cost.N, cost.r, cost.p].every((x) => Number.isInteger(x) && x > 0)) return false;
    const expected = Buffer.from(hash, 'base64');
    const actual = await derive(password, Buffer.from(salt, 'base64'), cost);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export type PasswordProblem = 'short' | 'long' | 'mismatch';

export const PASSWORD_PROBLEM_TEXT: Record<PasswordProblem, string> = {
  short: `The password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
  long: `The password must be at most ${MAX_PASSWORD_LENGTH} characters.`,
  mismatch: 'The two passwords do not match.',
};

/** Why a new password is unacceptable, or undefined if it is fine. */
export function passwordProblem(password: string, confirm: string): PasswordProblem | undefined {
  if (password.length < MIN_PASSWORD_LENGTH) return 'short';
  if (password.length > MAX_PASSWORD_LENGTH) return 'long';
  if (password !== confirm) return 'mismatch';
  return undefined;
}
