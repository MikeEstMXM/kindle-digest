import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../app/context.js';
import {
  DEFAULT_COST,
  PASSWORD_PROBLEM_TEXT,
  hashPassword,
  passwordProblem,
  verifyPassword,
  type ScryptCost,
} from './password.js';
import { clientIp, rateKey } from './ip.js';
import { AuthRepo } from './store.js';
import { loginPage, setupPage, signedInPage } from './views.js';

/**
 * Login for the whole app.
 *
 * Everything is behind a session except /login, /setup (which 404s once a
 * password exists), /healthz and the htmx script. The gate is a global onRequest
 * hook, so a route added later is protected without anyone remembering to
 * protect it; the public list below is the only way out of it.
 */

export const SESSION_COOKIE = 'kd_session';
const DAY_MS = 24 * 60 * 60 * 1000;
export const SESSION_DAYS = 30;
export const REMEMBER_DAYS = 365;
export const MAX_LOGIN_FAILURES = 5;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const FORM_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

/** Paths that need no session. Exact matches only; anything else is gated. */
const PUBLIC_PATHS = new Set(['/login', '/setup', '/healthz', '/vendor/htmx.min.js']);

export interface AuthSession {
  /** The cookie value; used to end this session and to spare it on password change. */
  token: string;
  userId: number;
  /** Per-session token every state-changing request must echo back. */
  csrf: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    session: AuthSession | null;
  }
}

export interface AuthOptions {
  /** scrypt cost for new hashes; tests lower it. Existing hashes carry their own. */
  cost?: ScryptCost;
  now?: () => number;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function cookieHeader(value: string, maxAgeSec: number): string {
  const expires = new Date(maxAgeSec > 0 ? Date.now() + maxAgeSec * 1000 : 0).toUTCString();
  // Max-Age and Expires both: old browsers only understand one of them.
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAgeSec}; Expires=${expires}; HttpOnly; Secure; SameSite=Lax`;
}

/** Only same-site paths: never an absolute URL (open redirect) or the auth pages themselves. */
export function safeNext(raw: unknown): string {
  const next = str(raw);
  // Printable ASCII only: anything else (control characters, DEL, non-Latin-1)
  // is not a valid header value and would crash the response when redirected to.
  if (!/^\/[\x21-\x7e]*$/.test(next) || next.startsWith('//') || next.includes('\\')) return '/';
  return PUBLIC_PATHS.has(next.split('?')[0]) ? '/' : next;
}

const sameToken = (a: string, b: string): boolean => {
  // Hash first so the comparison is over equal-length buffers.
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
};

export function registerAuth(
  app: FastifyInstance,
  ctx: AppContext,
  opts: AuthOptions = {},
): AuthRepo {
  const repo = new AuthRepo(ctx.db);
  const now = opts.now ?? Date.now;
  const cost = opts.cost ?? DEFAULT_COST;
  const secret = ctx.env.sessionSecret ?? randomBytes(32).toString('hex');
  const owner = (): ReturnType<AuthRepo['userById']> => repo.userById(ctx.userId);

  // ─── Form tokens for pages with no session yet (login, setup) ──────────
  // Signed and expiring rather than stored: there is nothing to look up and
  // nothing to clean up. They stop a page on another site from submitting the
  // login form on the visitor's behalf.
  const makeFormToken = (): string => {
    const exp = String(now() + FORM_TOKEN_TTL_MS);
    return `${exp}.${createHmac('sha256', secret).update(`form:${exp}`).digest('hex')}`;
  };
  const formTokenOk = (token: string): boolean => {
    const [exp, sig] = token.split('.');
    if (!exp || !sig || Number(exp) < now()) return false;
    const want = createHmac('sha256', secret).update(`form:${exp}`).digest('hex');
    return sameToken(sig, want);
  };

  // A hash to spend the same time on when there is nothing to check against, so
  // an unknown username and a wrong password cost the same. Made now, not on the
  // first miss, or that first miss would be measurably slower.
  const dummyHash = hashPassword('not-a-real-password', cost);

  // ─── The gate ──────────────────────────────────────────────────────────
  app.decorateRequest('session', null);

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (PUBLIC_PATHS.has(path)) return;

    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const found = token ? repo.findSession(token, now()) : undefined;
    if (token && found && owner()) {
      req.session = { token, userId: found.userId, csrf: found.csrfToken };
      return;
    }

    // Lets a browser that keeps getting bounced prove whether its cookie came
    // back: a short hash of the Cookie header (never the header or token itself).
    const rawCookie = req.headers.cookie;
    req.log.info(
      {
        path: req.url.split('?')[0],
        cookieHash: rawCookie
          ? createHash('sha256').update(rawCookie).digest('hex').slice(0, 8)
          : 'none',
        hasSessionCookie: !!token,
        sessionFound: !!found,
        ua: str(req.headers['user-agent']).slice(0, 200),
      },
      'gate redirect to login',
    );

    const readOnly = req.method === 'GET' || req.method === 'HEAD';
    const dest = readOnly ? `/login?next=${encodeURIComponent(safeNext(req.url))}` : '/login';
    if (req.headers['hx-request']) {
      // htmx would swap the login page into a fragment; tell it to navigate.
      return reply.code(401).header('HX-Redirect', dest).type('text/plain').send('Signed out');
    }
    return reply.redirect(dest);
  });

  // ─── CSRF on everything that changes state ─────────────────────────────
  // The token comes from a hidden form field, the X-CSRF-Token header (htmx) or
  // the query string (multipart uploads, whose body is not parsed yet).
  app.addHook('preHandler', async (req, reply) => {
    if (!req.session) return;
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const query = (req.query ?? {}) as Record<string, unknown>;
    const sent = str(req.headers['x-csrf-token']) || str(body._csrf) || str(query._csrf);
    if (sent && sameToken(sent, req.session.csrf)) return;
    req.log.warn({ path: req.url.split('?')[0], ip: clientIp(req) }, 'csrf token missing or wrong');
    return reply
      .code(403)
      .type('text/html; charset=utf-8')
      .send(
        '<p>Security check failed. Go back, reload the page and try again.</p><p><a href="/">Home</a></p>',
      );
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    // Pages hold private data: do not let the back button show them after sign-out.
    if (
      !reply.hasHeader('Cache-Control') &&
      String(reply.getHeader('content-type')).startsWith('text/html')
    ) {
      reply.header('Cache-Control', 'private, no-store');
    }
    return payload;
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).type('text/plain').send('Not found'));

  // ─── Rate limit ────────────────────────────────────────────────────────
  /** Milliseconds until this address may try again, or 0 if it may try now. */
  const lockedOutFor = (key: string): number => {
    const { count, oldest } = repo.failuresSince(key, now() - LOGIN_WINDOW_MS);
    return count >= MAX_LOGIN_FAILURES && oldest !== null ? oldest + LOGIN_WINDOW_MS - now() : 0;
  };
  /**
   * Take one of this address's attempts, *before* the (slow) password check. If
   * the attempt were only recorded after a wrong answer, a burst of parallel
   * guesses would all pass the check while the first was still hashing. Returns
   * the wait in ms when over the limit, else 0 and the attempt is on the books;
   * a correct password clears the address's count again.
   */
  const takeAttempt = (ip: string): number => {
    const key = rateKey(ip);
    repo.purgeFailuresBefore(now() - LOGIN_WINDOW_MS);
    const wait = lockedOutFor(key);
    if (wait === 0) repo.recordFailure(key, now());
    return wait;
  };
  const logFailure = (req: FastifyRequest, what: string, userKnown: boolean): void => {
    req.log.warn({ ip: clientIp(req), what, userKnown }, 'failed login attempt');
  };
  const housekeeping = (): void => {
    repo.purgeExpiredSessions(now());
    repo.purgeFailuresBefore(now() - LOGIN_WINDOW_MS);
  };
  housekeeping();

  const tooMany = (reply: FastifyReply, waitMs: number): FastifyReply => {
    const minutes = Math.max(1, Math.ceil(waitMs / 60_000));
    return reply
      .code(429)
      .header('Retry-After', String(Math.ceil(waitMs / 1000)))
      .type('text/html; charset=utf-8')
      .send(
        loginPage({
          formToken: makeFormToken(),
          error: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        }),
      );
  };

  // ─── Public routes ─────────────────────────────────────────────────────
  app.get('/healthz', async (_req, reply) => {
    try {
      ctx.db.prepare('SELECT 1').get();
    } catch {
      return reply.code(503).type('text/plain').send('database unavailable');
    }
    return reply.type('text/plain').send('ok');
  });

  app.get('/login', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const next = safeNext(q.next);
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token && repo.findSession(token, now())) return reply.redirect(next);
    // Nothing to sign in to until the owner has chosen a password.
    if (!owner()?.passwordHash) return reply.redirect('/setup');
    return reply.type('text/html; charset=utf-8').send(
      loginPage({
        formToken: makeFormToken(),
        next: next === '/' ? '' : next,
        notice: q.setup === 'done' ? 'Password set. Sign in below.' : undefined,
      }),
    );
  });

  app.post('/login', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const next = safeNext(b.next);
    const showError = (code: number, error: string): FastifyReply =>
      reply
        .code(code)
        .type('text/html; charset=utf-8')
        .send(loginPage({ formToken: makeFormToken(), next: next === '/' ? '' : next, error }));

    if (!formTokenOk(str(b._csrf))) {
      return showError(403, 'This page expired. Please try again.');
    }
    const ip = clientIp(req);
    const wait = takeAttempt(ip);
    if (wait > 0) {
      req.log.warn({ ip }, 'login refused: too many failures');
      return tooMany(reply, wait);
    }

    const username = str(b.username).trim().toLowerCase().slice(0, 64);
    const password = str(b.password);
    const user = username ? repo.userByName(username) : undefined;
    const ok =
      password.length > 0 && password.length <= 1024 && user?.passwordHash
        ? await verifyPassword(password, user.passwordHash)
        : (await verifyPassword(password.slice(0, 1024), await dummyHash), false);
    if (!ok || !user || user.id !== ctx.userId) {
      logFailure(req, user ? 'wrong password' : 'unknown user', !!user);
      return showError(401, 'Wrong username or password.');
    }

    // A new session id on every login, so a cookie planted before login is worthless.
    const old = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (old) repo.deleteSession(old);
    const remember = str(b.remember) !== '';
    const lifetimeMs = (remember ? REMEMBER_DAYS : SESSION_DAYS) * DAY_MS;
    const sessionToken = randomBytes(32).toString('base64url');
    repo.createSession({
      token: sessionToken,
      userId: user.id,
      csrfToken: randomBytes(24).toString('base64url'),
      remember,
      expiresAt: now() + lifetimeMs,
      ip,
      userAgent: str(req.headers['user-agent']),
    });
    repo.clearFailures(rateKey(ip));
    housekeeping();
    req.log.info({ ip, remember }, 'login ok');
    // 200 + refresh, not a 302: the Kindle browser drops a cookie set on a redirect.
    return reply
      .header('Set-Cookie', cookieHeader(sessionToken, Math.floor(lifetimeMs / 1000)))
      .type('text/html; charset=utf-8')
      .send(signedInPage(next));
  });

  // 404 — not a redirect, not a hint — as soon as a password exists.
  app.get('/setup', async (_req, reply) => {
    if (owner()?.passwordHash) return reply.code(404).type('text/plain').send('Not found');
    return reply.type('text/html; charset=utf-8').send(setupPage({ formToken: makeFormToken() }));
  });

  app.post('/setup', async (req, reply) => {
    const user = owner();
    if (!user || user.passwordHash) return reply.code(404).type('text/plain').send('Not found');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const again = (error: string, code = 400): FastifyReply =>
      reply
        .code(code)
        .type('text/html; charset=utf-8')
        .send(setupPage({ formToken: makeFormToken(), error }));
    if (!formTokenOk(str(b._csrf))) return again('This page expired. Please try again.', 403);
    const problem = passwordProblem(str(b.password), str(b.confirm));
    if (problem) return again(PASSWORD_PROBLEM_TEXT[problem]);
    const won = repo.setInitialPassword(user.id, await hashPassword(str(b.password), cost));
    if (!won) return reply.code(404).type('text/plain').send('Not found');
    req.log.info({ ip: clientIp(req) }, 'initial password set');
    return reply.redirect('/login?setup=done');
  });

  // ─── Routes that need a session (the gate has already checked) ─────────
  app.post('/logout', async (req, reply) => {
    if (req.session) repo.deleteSession(req.session.token);
    return reply.header('Set-Cookie', cookieHeader('', 0)).redirect('/login');
  });

  app.post('/settings/password', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const back = (code: string): FastifyReply => reply.redirect(`/settings?pw=${code}#password`);
    const ip = clientIp(req);
    if (takeAttempt(ip) > 0) return back('limited');
    const user = owner();
    if (!user?.passwordHash || !(await verifyPassword(str(b.current), user.passwordHash))) {
      logFailure(req, 'wrong current password', !!user);
      return back('wrong');
    }
    repo.clearFailures(rateKey(ip));
    const problem = passwordProblem(str(b.password), str(b.confirm));
    if (problem) return back(problem);
    repo.changePassword(user.id, await hashPassword(str(b.password), cost));
    // Whoever else was signed in (a lost Kindle, a stolen cookie) is signed out.
    const dropped = req.session ? repo.deleteOtherSessions(user.id, req.session.token) : 0;
    req.log.info({ ip, otherSessionsEnded: dropped }, 'password changed');
    return back('ok');
  });

  return repo;
}
