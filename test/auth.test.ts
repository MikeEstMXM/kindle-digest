import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  FAST_COST,
  PASSWORD,
  cookieOf,
  form,
  formTokenOf,
  login,
  makeApp,
  setPassword,
  signIn,
  type TestApp,
} from './helpers/app.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { rateKey } from '../src/auth/ip.js';
import {
  LOGIN_WINDOW_MS,
  MAX_LOGIN_FAILURES,
  REMEMBER_DAYS,
  SESSION_DAYS,
} from '../src/auth/index.js';

const DAY = 24 * 60 * 60 * 1000;
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

/** Where the sign-in page's meta refresh sends the browser, decoded the way a browser would. */
function refreshTarget(html: string): string | undefined {
  const m = /<meta http-equiv="refresh" content="0;url=([^"]*)">/.exec(html);
  return m?.[1]
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

let t: TestApp;
beforeEach(() => {
  t = makeApp();
});

// ─── The gate ─────────────────────────────────────────────────────────────

/** Every route the app has, except the four that are public on purpose. */
const GET_ROUTES = [
  '/',
  '/?date=2026-11-10',
  '/feeds',
  '/settings',
  '/download/News',
  '/download-all',
  '/issues',
  '/issues/news',
  '/issues/news/news-2026-11-10.mobi',
  '/issues/news/news-2026-11-10.mobi/cover.jpg',
  '/no-such-page',
];
const POST_ROUTES = [
  '/toggle',
  '/send/News',
  '/send-all',
  '/feeds/add',
  '/feeds/refresh',
  '/feeds/import',
  '/feeds/1/delete',
  '/feeds/1/move',
  '/feeds/News/rename',
  '/feeds/News/cadence',
  '/feeds/News/cover',
  '/settings',
  '/settings/password',
  '/logout',
];

describe('auth gate: logged out', () => {
  it.each(GET_ROUTES)('GET %s redirects to the login page', async (url) => {
    await setPassword(t);
    const res = await t.app.inject(url);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/login?next=${encodeURIComponent(url)}`);
    expect(res.body).not.toContain('Kindle Digest —');
  });

  it.each(POST_ROUTES)('POST %s redirects to the login page and does nothing', async (url) => {
    const res = await t.app.inject({ method: 'POST', url, headers: FORM, payload: 'x=1' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('answers a htmx request with a 401 + HX-Redirect instead of a page to swap in', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/toggle',
      headers: { ...FORM, 'hx-request': 'true' },
      payload: 'x=1',
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['hx-redirect']).toBe('/login');
  });

  it('does not accept a forged or expired session cookie', async () => {
    await setPassword(t);
    expect(
      (await t.app.inject({ url: '/', headers: { cookie: 'kd_session=forged' } })).statusCode,
    ).toBe(302);
    const s = await signIn(t);
    t.clock.now += 31 * DAY;
    expect((await s.get('/')).statusCode).toBe(302);
  });

  it('leaves exactly the public routes open', async () => {
    expect((await t.app.inject('/healthz')).body).toBe('ok');
    expect((await t.app.inject('/vendor/htmx.min.js')).statusCode).toBe(200);
    expect((await t.app.inject('/login')).statusCode).toBe(302); // -> /setup, no password yet
    expect((await t.app.inject('/setup')).statusCode).toBe(200);
  });

  it('every route in the source is either covered above or deliberately public', () => {
    const files = ['src/web/server.ts', 'src/issues/routes.ts', 'src/auth/index.ts'];
    const found = new Set<string>();
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(/app\.(get|post)\(\s*'([^']+)'/g)) {
        found.add(`${m[1].toUpperCase()} ${m[2]}`);
      }
    }
    const pathOf = (url: string): string => url.split('?')[0];
    const covered = [
      ...GET_ROUTES.map((u) => `GET ${pathOf(u)}`),
      ...POST_ROUTES.map((u) => `POST ${pathOf(u)}`),
    ];
    const isCovered = (route: string): boolean => {
      const [method, path] = route.split(' ');
      const re = new RegExp(
        `^${method} ${path.replace(/:[a-z]+/g, '[^/]+').replace(/\//g, '\\/')}$`,
      );
      return covered.some((c) => re.test(c));
    };
    const publicRoutes = [
      'GET /healthz',
      'GET /login',
      'POST /login',
      'GET /setup',
      'POST /setup',
      'GET /vendor/htmx.min.js',
    ];
    const uncovered = [...found].filter((r) => !publicRoutes.includes(r) && !isCovered(r));
    expect(uncovered, 'add new routes to GET_ROUTES / POST_ROUTES').toEqual([]);
  });
});

// ─── /setup ───────────────────────────────────────────────────────────────

describe('/setup', () => {
  const post = async (fields: Record<string, string>) => {
    const page = await t.app.inject('/setup');
    return t.app.inject({
      method: 'POST',
      url: '/setup',
      headers: FORM,
      payload: form({ _csrf: formTokenOf(page.body), ...fields }),
    });
  };

  it('seeds exactly one account, with no password', () => {
    const users = t.db.prepare('SELECT username, password_hash FROM users').all();
    expect(users).toEqual([{ username: 'mharm', password_hash: null }]);
  });

  it('serves a plain form while there is no password', async () => {
    const res = await t.app.inject('/setup');
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/name="confirm"/);
    expect(res.body).not.toMatch(/<script/i);
  });

  it('refuses a short password and a mismatch, and stays open', async () => {
    expect((await post({ password: 'short', confirm: 'short' })).body).toMatch(/at least 12/);
    expect((await post({ password: PASSWORD, confirm: PASSWORD + 'x' })).body).toMatch(
      /do not match/,
    );
    expect((await t.app.inject('/setup')).statusCode).toBe(200);
  });

  it('refuses a submission without the form token', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/setup',
      headers: FORM,
      payload: form({ password: PASSWORD, confirm: PASSWORD }),
    });
    expect(res.statusCode).toBe(403);
    expect((await t.app.inject('/setup')).statusCode).toBe(200);
  });

  it('sets the password once; after that /setup is 404 forever', async () => {
    const token = formTokenOf((await t.app.inject('/setup')).body);
    const submit = (password: string) =>
      t.app.inject({
        method: 'POST',
        url: '/setup',
        headers: FORM,
        payload: form({ _csrf: token, password, confirm: password }),
      });
    const ok = await submit(PASSWORD);
    expect(ok.statusCode).toBe(302);
    expect(ok.headers.location).toBe('/login?setup=done');

    expect((await t.app.inject('/setup')).statusCode).toBe(404);
    const again = await submit('another long password'); // a still-valid token changes nothing
    expect(again.statusCode).toBe(404);
    // ...and it did not replace the password.
    expect((await login(t)).statusCode).toBe(200);
  });

  it('stores a salted scrypt hash, never the password', async () => {
    await setPassword(t);
    const hash = t.db.prepare('SELECT password_hash FROM users').pluck().get() as string;
    expect(hash).toMatch(/^scrypt\$\d+\$\d+\$\d+\$/);
    expect(hash).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyPassword(PASSWORD + '!', hash)).toBe(false);
    expect(await hashPassword(PASSWORD, FAST_COST)).not.toBe(
      await hashPassword(PASSWORD, FAST_COST),
    );
  });

  it('two simultaneous setups: only one wins', async () => {
    const page = await t.app.inject('/setup');
    const token = formTokenOf(page.body);
    const submit = (pw: string) =>
      t.app.inject({
        method: 'POST',
        url: '/setup',
        headers: FORM,
        payload: form({ _csrf: token, password: pw, confirm: pw }),
      });
    const codes = (
      await Promise.all([submit('first password here'), submit('second password here')])
    ).map((r) => r.statusCode);
    expect(codes.sort()).toEqual([302, 404]);
  });
});

// ─── /login ───────────────────────────────────────────────────────────────

describe('/login', () => {
  beforeEach(async () => {
    await setPassword(t);
  });

  it('is a plain HTML form that needs no JavaScript (Kindle browser)', async () => {
    const res = await t.app.inject('/login');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).not.toMatch(/<script/i);
    expect(res.body).not.toMatch(/\son[a-z]+=/i); // no inline handlers
    expect(res.body).not.toContain('htmx');
    expect(res.body).toMatch(/<form method="post" action="\/login">/);
    expect(res.body).toMatch(/name="username"/);
    expect(res.body).toMatch(/type="password"/);
    expect(res.body).toMatch(/type="checkbox" name="remember"/);
    expect(res.body).toMatch(/Keep me signed in/);
  });

  it('a plain form POST signs in and sets a hardened session cookie', async () => {
    const res = await login(t);
    // 200 with a refresh, not a 302: the Kindle browser drops a cookie set on a redirect.
    expect(res.statusCode).toBe(200);
    expect(res.headers.location).toBeUndefined();
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(refreshTarget(res.body)).toBe('/');
    expect(res.body).toContain('<a href="/">Signed in, continue</a>');
    const set = String(res.headers['set-cookie']);
    expect(set).toMatch(/^kd_session=[\w-]{40,};/);
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/'])
      expect(set).toContain(attr);
    expect(set).toContain(`Max-Age=${SESSION_DAYS * 86400}`);

    const home = await t.app.inject({ url: '/', headers: { cookie: cookieOf(res)! } });
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain('Sign out');
  });

  it('"keep me signed in" lasts a year, otherwise 30 days', async () => {
    const short = await login(t);
    const long = await login(t, { remember: true });
    expect(String(short.headers['set-cookie'])).toContain(`Max-Age=${30 * 86400}`);
    expect(String(long.headers['set-cookie'])).toContain(`Max-Age=${REMEMBER_DAYS * 86400}`);

    t.clock.now += 40 * DAY;
    const get = (r: typeof short) =>
      t.app.inject({ url: '/settings', headers: { cookie: cookieOf(r)! } });
    expect((await get(short)).statusCode).toBe(302);
    expect((await get(long)).statusCode).toBe(200);
    t.clock.now += 330 * DAY;
    expect((await get(long)).statusCode).toBe(302);
  });

  it('keeps sessions on the server, storing only a hash of the cookie', async () => {
    const res = await login(t);
    const token = cookieOf(res)!.split('=')[1];
    const rows = t.db.prepare('SELECT id_hash FROM sessions').pluck().all();
    expect(rows).toEqual([createHash('sha256').update(token).digest('hex')]);
  });

  it('is generic about what was wrong', async () => {
    const wrongPw = await login(t, { password: 'not the password' });
    expect(wrongPw.statusCode).toBe(401);
    expect(wrongPw.body).toContain('Wrong username or password.');
    expect(cookieOf(wrongPw)).toBeUndefined();

    const page = await t.app.inject('/login');
    const wrongUser = await t.app.inject({
      method: 'POST',
      url: '/login',
      headers: FORM,
      payload: form({ _csrf: formTokenOf(page.body), username: 'admin', password: PASSWORD }),
    });
    expect(wrongUser.statusCode).toBe(401);
    expect(wrongUser.body).toContain('Wrong username or password.');
  });

  it('rejects a POST without a valid form token', async () => {
    const base = { username: 'mharm', password: PASSWORD };
    for (const _csrf of [undefined, 'garbage', '1.deadbeef']) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/login',
        headers: FORM,
        payload: form(_csrf ? { ...base, _csrf } : base),
      });
      expect(res.statusCode).toBe(403);
      expect(cookieOf(res)).toBeUndefined();
    }
    // An expired token is refused too.
    const page = await t.app.inject('/login');
    t.clock.now += 3 * 60 * 60 * 1000;
    const res = await t.app.inject({
      method: 'POST',
      url: '/login',
      headers: FORM,
      payload: form({ ...base, _csrf: formTokenOf(page.body) }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('goes back to where you were headed, but never off-site', async () => {
    const via = async (dest: string) => refreshTarget((await login(t, { next: dest })).body);
    expect(await via('/issues/news')).toBe('/issues/news');
    expect(await via('/feeds?x=1&y=2')).toBe('/feeds?x=1&y=2');
    for (const evil of [
      'https://evil.example/',
      '//evil.example',
      '/\\evil.example',
      'javascript:alert(1)',
      '/login',
    ]) {
      expect(await via(evil), evil).toBe('/');
    }
    const redirected = await t.app.inject('/issues/news?page=2');
    expect(redirected.headers.location).toBe('/login?next=%2Fissues%2Fnews%3Fpage%3D2');
  });

  it('survives a hostile ?next= (non-ASCII, DEL, control characters) instead of crashing', async () => {
    const hostile = ['/€', '/\u007f', '/\u2028', '/a\u0000b', '/ü?x=ß', '/%E2%82%AC'];
    for (const next of hostile) {
      const res = await login(t, { next });
      expect(res.statusCode, JSON.stringify(next)).toBe(200);
      const target = refreshTarget(res.body);
      expect(target).toMatch(/^\/[\x21-\x7e]*$/); // always a plain-ASCII path
      if (!/%/.test(next)) expect(target).toBe('/');
    }
    // The same through the signed-in GET /login?next=... path.
    const cookie = cookieOf(await login(t))!;
    for (const q of ['/%E2%82%AC', '/%7F', '/%E2%80%A8', '/%00']) {
      const res = await t.app.inject({ url: `/login?next=${q}`, headers: { cookie } });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/');
    }
    // ...and the app is still up.
    expect((await t.app.inject('/healthz')).statusCode).toBe(200);
  });

  it('cannot be turned into markup or an off-site refresh through ?next=', async () => {
    for (const next of ['/"><script>alert(1)</script>', "/'onmouseover='x", '/a"b&c<d>']) {
      const res = await login(t, { next });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toMatch(/<script/i);
      // Exactly one meta tag and one link, each with an intact quoted value.
      expect(res.body.match(/<meta /g)).toHaveLength(2); // charset + refresh
      expect(res.body.match(/<a /g)).toHaveLength(1);
      expect(refreshTarget(res.body)).toBe(next); // what the browser decodes is the plain path
    }
    for (const evil of ['https://evil.example/', '//evil.example', 'javascript:alert(1)']) {
      expect(refreshTarget((await login(t, { next: evil })).body), evil).toBe('/');
    }
  });

  it('logs a short hash and presence of the cookie, never the token, when the gate redirects', async () => {
    const token = cookieOf(await login(t))!.split('=')[1];
    t.logs.length = 0;
    const ua = 'Mozilla/5.0 (Linux; Kindle) Silk/Test';
    await t.app.inject({ url: '/issues', headers: { 'user-agent': ua } });
    await t.app.inject({
      url: '/issues',
      headers: { 'user-agent': ua, cookie: 'kd_session=stale-token-value' },
    });
    await t.app.inject({
      url: '/issues',
      headers: { cookie: `kd_session=${token}`, 'user-agent': ua },
    }); // signed in: no redirect, no line
    const lines = t.logs
      .map((l) => JSON.parse(l))
      .filter((l) => l.msg === 'gate redirect to login');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ cookieHash: 'none', hasSessionCookie: false, ua });
    expect(lines[1]).toMatchObject({ hasSessionCookie: true, sessionFound: false, ua });
    expect(lines[1].cookieHash).toMatch(/^[0-9a-f]{8}$/);
    const everything = t.logs.join('\n');
    expect(everything).not.toContain(token);
    expect(everything).not.toContain('stale-token-value');
  });

  it('replaces any session id sent in with a fresh one', async () => {
    const first = cookieOf(await login(t))!;
    const page = await t.app.inject({ url: '/login', headers: { cookie: first } });
    expect(page.statusCode).toBe(302); // already signed in
    const res = await t.app.inject({
      method: 'POST',
      url: '/login',
      headers: { ...FORM, cookie: first },
      payload: form({
        _csrf: formTokenOf((await t.app.inject('/login')).body),
        username: 'mharm',
        password: PASSWORD,
      }),
    });
    expect(cookieOf(res)).not.toBe(first);
    expect((await t.app.inject({ url: '/settings', headers: { cookie: first } })).statusCode).toBe(
      302,
    );
  });

  it('logout ends the session on the server and clears the cookie', async () => {
    const s = await signIn(t);
    const res = await s.post('/logout');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
    expect(String(res.headers['set-cookie'])).toMatch(/Max-Age=0/);
    expect((await s.get('/settings')).statusCode).toBe(302); // the old cookie is dead
  });

  it('logout needs the CSRF token too', async () => {
    const s = await signIn(t);
    expect((await s.post('/logout', {}, false)).statusCode).toBe(403);
    expect((await s.get('/settings')).statusCode).toBe(200);
  });
});

// ─── Rate limit ───────────────────────────────────────────────────────────

describe('login rate limit', () => {
  beforeEach(async () => {
    await setPassword(t);
  });

  it(`locks an address out after ${MAX_LOGIN_FAILURES} failures, even for the right password`, async () => {
    for (let i = 0; i < MAX_LOGIN_FAILURES; i++) {
      expect(
        (await login(t, { password: 'wrong wrong wrong', ip: '203.0.113.7' })).statusCode,
      ).toBe(401);
    }
    const locked = await login(t, { ip: '203.0.113.7' }); // correct password
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    expect(locked.body).toMatch(/Too many failed attempts/);
    expect(cookieOf(locked)).toBeUndefined();
  });

  it('is keyed on CF-Connecting-IP: someone else is unaffected', async () => {
    for (let i = 0; i < MAX_LOGIN_FAILURES; i++)
      await login(t, { password: 'wrong wrong wrong', ip: '203.0.113.7' });
    expect((await login(t, { ip: '203.0.113.7' })).statusCode).toBe(429);
    expect((await login(t, { ip: '198.51.100.9' })).statusCode).toBe(200);
  });

  it('falls back to the socket address, and ignores a junk CF header', async () => {
    for (let i = 0; i < MAX_LOGIN_FAILURES; i++) await login(t, { password: 'wrong wrong wrong' });
    expect((await login(t)).statusCode).toBe(429);
    // A garbage header cannot be used to dodge the limit: it is ignored, so
    // the attempt is counted against the socket address again.
    expect((await login(t, { ip: 'not-an-ip' })).statusCode).toBe(429);
  });

  it('holds under a burst of parallel guesses (the attempt is counted before the slow hash)', async () => {
    const burst = await Promise.all(
      Array.from({ length: 40 }, () =>
        login(t, { password: 'wrong wrong wrong', ip: '203.0.113.50' }),
      ),
    );
    const codes = burst.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 401)).toHaveLength(MAX_LOGIN_FAILURES);
    expect(codes.filter((c) => c === 429)).toHaveLength(40 - MAX_LOGIN_FAILURES);
    expect((await login(t, { ip: '203.0.113.50' })).statusCode).toBe(429);
  });

  it('counts an IPv6 visitor by /64, so rotating addresses inside it does not reset the limit', async () => {
    for (let i = 0; i < MAX_LOGIN_FAILURES; i++) {
      await login(t, { password: 'wrong wrong wrong', ip: `2001:db8:1:2::${i + 1}` });
    }
    expect((await login(t, { ip: '2001:db8:1:2:aaaa:bbbb:cccc:dddd' })).statusCode).toBe(429);
    expect((await login(t, { ip: '2001:db8:1:3::1' })).statusCode).toBe(200); // a different /64
  });

  it('lets the address try again once the window has passed', async () => {
    for (let i = 0; i < MAX_LOGIN_FAILURES; i++) await login(t, { password: 'wrong wrong wrong' });
    expect((await login(t)).statusCode).toBe(429);
    t.clock.now += LOGIN_WINDOW_MS + 1000;
    expect((await login(t)).statusCode).toBe(200);
  });

  it('a successful sign-in clears the count', async () => {
    for (let i = 0; i < MAX_LOGIN_FAILURES - 1; i++)
      await login(t, { password: 'wrong wrong wrong' });
    expect((await login(t)).statusCode).toBe(200);
    for (let i = 0; i < MAX_LOGIN_FAILURES - 1; i++) {
      expect((await login(t, { password: 'wrong wrong wrong' })).statusCode).toBe(401);
    }
  });

  it('logs every failure with the address, and never the password', async () => {
    await login(t, { password: 'hunter2hunter2', ip: '203.0.113.7' });
    const line = t.logs.map((l) => JSON.parse(l)).find((l) => l.msg === 'failed login attempt');
    expect(line).toMatchObject({ ip: '203.0.113.7', userKnown: true, what: 'wrong password' });
    expect(t.logs.join('')).not.toContain('hunter2hunter2');
  });

  it('does not keep what was typed in the username box (it is often a password on a Kindle keyboard)', async () => {
    const page = await t.app.inject('/login');
    await t.app.inject({
      method: 'POST',
      url: '/login',
      headers: FORM,
      payload: form({
        _csrf: formTokenOf(page.body),
        username: 'typed-by-mistake-secret',
        password: 'x',
      }),
    });
    expect(t.logs.join('')).not.toContain('typed-by-mistake-secret');
    expect(JSON.stringify(t.db.prepare('SELECT * FROM login_failures').all())).not.toContain(
      'typed-by-mistake',
    );
  });
});

// ─── CSRF ─────────────────────────────────────────────────────────────────

describe('CSRF protection', () => {
  it('rejects a state-changing POST with no token, a wrong token, or a token from another session', async () => {
    const a = await signIn(t);
    const b = await login(t); // a second session with its own token
    expect(b.statusCode).toBe(200);
    const attempts = [
      a.post('/settings', { timezone: 'UTC' }, false),
      a.post('/settings', { timezone: 'UTC', _csrf: 'wrong' }, false),
      t.app.inject({
        method: 'POST',
        url: '/settings',
        headers: { ...FORM, cookie: a.cookie, 'x-csrf-token': 'wrong' },
        payload: 'timezone=UTC',
      }),
      t.app.inject({
        method: 'POST',
        url: '/settings',
        headers: { ...FORM, cookie: cookieOf(b)! },
        payload: form({ timezone: 'UTC', _csrf: a.csrf }),
      }),
    ];
    for (const res of await Promise.all(attempts)) expect(res.statusCode).toBe(403);
    expect(t.ctx.settings.get('timezone')).toBeUndefined();
  });

  it('accepts the token as a form field, as the htmx header, or in the query (uploads)', async () => {
    const s = await signIn(t);
    expect((await s.post('/settings', { timezone: 'Europe/Paris' })).statusCode).toBe(302);
    expect(t.ctx.settings.get('timezone')).toBe('Europe/Paris');

    const viaHeader = await t.app.inject({
      method: 'POST',
      url: '/toggle',
      headers: { ...FORM, cookie: s.cookie, 'x-csrf-token': s.csrf, 'hx-request': 'true' },
      payload: form({
        date: '2026-11-10',
        itemId: '5',
        folder: 'News',
        title: 't',
        feedTitle: 'f',
        included: 'false',
      }),
    });
    expect(viaHeader.statusCode).toBe(200);
    expect(t.ctx.selection.excludedIds('2026-11-10').has('5')).toBe(true);

    const viaQuery = await t.app.inject({
      method: 'POST',
      url: `/feeds/import?_csrf=${encodeURIComponent(s.csrf)}`,
      headers: { cookie: s.cookie, 'content-type': 'multipart/form-data; boundary=x' },
      payload: '--x--\r\n',
    });
    expect(viaQuery.statusCode).not.toBe(403);
  });

  it('every POST form on every page carries the token, so the app works without JavaScript', async () => {
    const s = await signIn(t);
    t.ctx.feeds.add('https://example.com/feed.xml', 'Example', 'News');
    for (const url of ['/', '/feeds', '/settings', '/issues']) {
      const body = (await s.get(url)).body;
      const forms = body.match(/<form\b[^>]*>(?:(?!<\/form>)[\s\S])*/gi) ?? [];
      for (const f of forms.filter((x) => /method="post"/i.test(x))) {
        const ok =
          f.includes(`name="_csrf" value="${s.csrf}"`) ||
          f.includes(`_csrf=${encodeURIComponent(s.csrf)}`);
        expect(ok, `${url}: ${f.slice(0, 120)}`).toBe(true);
      }
      if (url !== '/issues') expect(body).toContain(`hx-headers='{"X-CSRF-Token":"${s.csrf}"}'`);
    }
  });

  it('the Kindle-visible pages need no JavaScript', async () => {
    const s = await signIn(t);
    for (const url of ['/issues', '/login']) {
      expect((await t.app.inject(url)).body).not.toMatch(/<script/i);
    }
    expect((await s.get('/issues')).body).not.toMatch(/<script/i);
  });
});

// ─── Changing the password ────────────────────────────────────────────────

describe('change password (Settings)', () => {
  it('needs the current password', async () => {
    const s = await signIn(t);
    const bad = await s.post('/settings/password', {
      current: 'nope nope nope',
      password: 'brand new password',
      confirm: 'brand new password',
    });
    expect(bad.headers.location).toBe('/settings?pw=wrong#password');
    expect((await login(t)).statusCode).toBe(200); // old password still works
  });

  it('validates the new one', async () => {
    const s = await signIn(t);
    const go = (password: string, confirm: string) =>
      s.post('/settings/password', { current: PASSWORD, password, confirm });
    expect((await go('short', 'short')).headers.location).toContain('pw=short');
    expect((await go('long enough password', 'different password')).headers.location).toContain(
      'pw=mismatch',
    );
    const page = await s.get('/settings?pw=short');
    expect(page.body).toMatch(/at least 12 characters/);
  });

  it('changes it, signs other devices out, and keeps this one', async () => {
    const s = await signIn(t);
    const kindle = cookieOf(await login(t, { remember: true }))!;
    const res = await s.post('/settings/password', {
      current: PASSWORD,
      password: 'brand new password',
      confirm: 'brand new password',
    });
    expect(res.headers.location).toBe('/settings?pw=ok#password');

    expect((await s.get('/settings')).statusCode).toBe(200);
    expect((await t.app.inject({ url: '/settings', headers: { cookie: kindle } })).statusCode).toBe(
      302,
    );
    expect((await login(t, { password: PASSWORD })).statusCode).toBe(401);
    expect((await login(t, { password: 'brand new password' })).statusCode).toBe(200);
  });

  it('counts wrong current passwords toward the rate limit', async () => {
    const s = await signIn(t);
    for (let i = 0; i < MAX_LOGIN_FAILURES; i++) {
      await s.post('/settings/password', {
        current: 'wrong wrong wrong',
        password: 'x'.repeat(14),
        confirm: 'x'.repeat(14),
      });
    }
    const res = await s.post('/settings/password', {
      current: PASSWORD,
      password: 'x'.repeat(14),
      confirm: 'x'.repeat(14),
    });
    expect(res.headers.location).toContain('pw=limited');
  });
});

describe('request log', () => {
  it('does not write the CSRF token of an upload URL to the log', async () => {
    const s = await signIn(t);
    await t.app.inject({
      method: 'POST',
      url: `/feeds/import?_csrf=${encodeURIComponent(s.csrf)}`,
      headers: { cookie: s.cookie, 'content-type': 'multipart/form-data; boundary=x' },
      payload: '--x--\r\n',
    });
    expect(t.logs.join('')).toContain('/feeds/import?_csrf=[token]');
    expect(t.logs.join('')).not.toContain(s.csrf);
  });
});

describe('response headers', () => {
  it('forbids framing, sniffing and caching of private pages', async () => {
    const s = await signIn(t);
    const res = await s.get('/settings');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toContain('no-store');
  });
});

describe('rateKey', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['2001:db8:1:2::1', 'v6:2001:0db8:0001:0002'],
    ['2001:DB8:1:2:ffff:ffff:ffff:ffff', 'v6:2001:0db8:0001:0002'],
    ['2001:db8::1', 'v6:2001:0db8:0000:0000'],
    ['::1', 'v6:0000:0000:0000:0000'],
    ['fe80::1%eth0', 'v6:fe80:0000:0000:0000'],
    ['unknown', 'unknown'],
  ])('%s -> %s', (ip, key) => expect(rateKey(ip)).toBe(key));
});
