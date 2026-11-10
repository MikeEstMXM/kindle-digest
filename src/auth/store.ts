import { createHash } from 'node:crypto';
import type { DB } from '../db/schema.js';

export interface UserRow {
  id: number;
  username: string;
  passwordHash: string | null;
}

export interface SessionRow {
  userId: number;
  csrfToken: string;
  expiresAt: number;
}

/** sha256 of the cookie value: the database never holds a usable session id. */
export function hashSessionId(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Users, sessions and the failed-login log. */
export class AuthRepo {
  constructor(private db: DB) {}

  // ─── Users ───────────────────────────────────────────────────────────────

  userByName(username: string): UserRow | undefined {
    return this.mapUser(this.db.prepare('SELECT * FROM users WHERE username = ?').get(username));
  }

  userById(id: number): UserRow | undefined {
    return this.mapUser(this.db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  }

  private mapUser(row: unknown): UserRow | undefined {
    const r = row as { id: number; username: string; password_hash: string | null } | undefined;
    return r ? { id: r.id, username: r.username, passwordHash: r.password_hash } : undefined;
  }

  /**
   * First-time password. The `IS NULL` is the whole lock: of two simultaneous
   * /setup submissions exactly one changes a row. Returns whether this one won.
   */
  setInitialPassword(userId: number, hash: string): boolean {
    const now = Date.now();
    return (
      this.db
        .prepare(
          `UPDATE users SET password_hash = ?, password_changed_at = ?
           WHERE id = ? AND password_hash IS NULL`,
        )
        .run(hash, now, userId).changes === 1
    );
  }

  changePassword(userId: number, hash: string): void {
    this.db
      .prepare('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?')
      .run(hash, Date.now(), userId);
  }

  // ─── Sessions ────────────────────────────────────────────────────────────

  createSession(s: {
    token: string;
    userId: number;
    csrfToken: string;
    remember: boolean;
    expiresAt: number;
    ip: string;
    userAgent?: string;
  }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sessions
           (id_hash, user_id, csrf_token, remember, created_at, expires_at, last_seen_at, ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        hashSessionId(s.token),
        s.userId,
        s.csrfToken,
        s.remember ? 1 : 0,
        now,
        s.expiresAt,
        now,
        s.ip,
        s.userAgent?.slice(0, 300) ?? null,
      );
  }

  /** The live session for a cookie value, or undefined if unknown or expired. */
  findSession(token: string, now: number = Date.now()): SessionRow | undefined {
    const r = this.db
      .prepare('SELECT user_id, csrf_token, expires_at FROM sessions WHERE id_hash = ?')
      .get(hashSessionId(token)) as
      | { user_id: number; csrf_token: string; expires_at: number }
      | undefined;
    if (!r || r.expires_at <= now) return undefined;
    return { userId: r.user_id, csrfToken: r.csrf_token, expiresAt: r.expires_at };
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(hashSessionId(token));
  }

  /** After a password change: every session except the one making the change. */
  deleteOtherSessions(userId: number, keepToken: string): number {
    return this.db
      .prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?')
      .run(userId, hashSessionId(keepToken)).changes;
  }

  purgeExpiredSessions(now: number = Date.now()): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  }

  // ─── Failed logins ───────────────────────────────────────────────────────

  /** `key` is the rate-limit key for an address (see rateKey), not necessarily the raw IP. */
  recordFailure(key: string, now: number = Date.now()): void {
    this.db.prepare('INSERT INTO login_failures (ip, at) VALUES (?, ?)').run(key, now);
  }

  /** Failures from this address since `since`, and when the oldest of them was. */
  failuresSince(ip: string, since: number): { count: number; oldest: number | null } {
    const r = this.db
      .prepare(
        'SELECT COUNT(*) AS n, MIN(at) AS oldest FROM login_failures WHERE ip = ? AND at > ?',
      )
      .get(ip, since) as { n: number; oldest: number | null };
    return { count: r.n, oldest: r.oldest };
  }

  clearFailures(ip: string): void {
    this.db.prepare('DELETE FROM login_failures WHERE ip = ?').run(ip);
  }

  purgeFailuresBefore(before: number): void {
    this.db.prepare('DELETE FROM login_failures WHERE at <= ?').run(before);
  }
}
