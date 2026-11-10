import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { AppContext } from '../../src/app/context.js';
import type { Env } from '../../src/config/env.js';
import { openDb, OWNER_USER_ID, type DB } from '../../src/db/schema.js';
import {
  RunLogRepo,
  SelectionRepo,
  SettingsRepo,
  DeliveryRepo,
} from '../../src/db/repositories.js';
import { ArticleRepo, FeedRepo, FolderSettingsRepo } from '../../src/db/feedRepos.js';
import { IssueRepo } from '../../src/db/issueRepo.js';
import { ReaderClient } from '../../src/reader/client.js';
import { buildServer } from '../../src/web/server.js';

/** Cheap scrypt so a test that signs in does not spend a second hashing. */
export const FAST_COST = { N: 1024, r: 8, p: 1 };
export const PASSWORD = 'correct horse battery';

export function testEnv(over: Partial<Env> = {}): Env {
  return {
    port: 3000,
    appBaseUrl: 'http://localhost:3000',
    databasePath: ':memory:',
    smtp: { port: 587, secure: false },
    defaults: { deliveryTime: '06:30', timezone: 'UTC', deliveryMode: 'download' },
    fulltextMinChars: 1800,
    digestDir: '/tmp/none',
    deliveryMaxAttempts: 5,
    buildConcurrency: 1,
    kindleDir: mkdtempSync(join(tmpdir(), 'kd-issues-')),
    kindleKeepIssues: 0,
    sessionSecret: 'test-secret',
    ebookConvertBin: 'ebook-convert',
    convertTimeoutMs: 1000,
    ...over,
  };
}

export function testContext(db: DB, env: Env = testEnv()): AppContext {
  const feeds = new FeedRepo(db, OWNER_USER_ID);
  const articles = new ArticleRepo(db, OWNER_USER_ID);
  return {
    env,
    db,
    userId: OWNER_USER_ID,
    settings: new SettingsRepo(db, OWNER_USER_ID),
    selection: new SelectionRepo(db),
    runLog: new RunLogRepo(db),
    delivery: new DeliveryRepo(db, OWNER_USER_ID),
    feeds,
    articles,
    folderSettings: new FolderSettingsRepo(db, OWNER_USER_ID),
    issues: new IssueRepo(db, OWNER_USER_ID),
    readerClient: () => new ReaderClient(feeds, articles),
  };
}

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  db: DB;
  /** What the app logged (one JSON string per line). */
  logs: string[];
  /** Move the app's clock (sessions, rate limit) without waiting. */
  clock: { now: number };
}

export function makeApp(env: Env = testEnv()): TestApp {
  const db = openDb(':memory:');
  const ctx = testContext(db, env);
  const logs: string[] = [];
  const clock = { now: Date.now() };
  const app = buildServer(ctx, undefined, {
    auth: { cost: FAST_COST, now: () => clock.now },
    logger: { level: 'info', stream: { write: (line: string) => void logs.push(line) } },
  });
  return { app, ctx, db, logs, clock };
}

export const form = (fields: Record<string, string>): string =>
  new URLSearchParams(fields).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

/** The hidden token a login/setup page carries. */
export function formTokenOf(html: string): string {
  const m = /name="_csrf" value="([^"]+)"/.exec(html);
  if (!m) throw new Error('no _csrf field on the page');
  return m[1];
}

/** `kd_session=...` from a response, ready to send back as a Cookie header. */
export function cookieOf(res: LightMyRequestResponse): string | undefined {
  const raw = res.headers['set-cookie'];
  const line = (Array.isArray(raw) ? raw : [raw]).find((c) => c?.startsWith('kd_session='));
  return line?.split(';')[0];
}

export async function setPassword(t: TestApp, password = PASSWORD): Promise<void> {
  const page = await t.app.inject('/setup');
  const res = await t.app.inject({
    method: 'POST',
    url: '/setup',
    headers: FORM,
    payload: form({ _csrf: formTokenOf(page.body), password, confirm: password }),
  });
  if (res.statusCode !== 302) throw new Error(`setup failed: ${res.statusCode} ${res.body}`);
}

export async function login(
  t: TestApp,
  opts: { password?: string; remember?: boolean; ip?: string; next?: string } = {},
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { ...FORM };
  if (opts.ip) headers['cf-connecting-ip'] = opts.ip;
  const page = await t.app.inject({
    url: '/login',
    headers: opts.ip ? { 'cf-connecting-ip': opts.ip } : {},
  });
  const fields: Record<string, string> = {
    _csrf: formTokenOf(page.body),
    username: 'mharm',
    password: opts.password ?? PASSWORD,
    next: opts.next ?? '',
  };
  if (opts.remember) fields.remember = '1';
  return t.app.inject({ method: 'POST', url: '/login', headers, payload: form(fields) });
}

export interface SignedIn {
  cookie: string;
  csrf: string;
  get(url: string): Promise<LightMyRequestResponse>;
  post(
    url: string,
    fields?: Record<string, string>,
    withToken?: boolean,
  ): Promise<LightMyRequestResponse>;
}

/** Set the password (if needed), sign in, and return helpers that carry the session. */
export async function signIn(t: TestApp, opts: { remember?: boolean } = {}): Promise<SignedIn> {
  if (!t.ctx.db.prepare('SELECT password_hash FROM users WHERE id = ?').pluck().get(t.ctx.userId)) {
    await setPassword(t);
  }
  const res = await login(t, { remember: opts.remember });
  const cookie = cookieOf(res);
  if (!cookie) throw new Error(`login failed: ${res.statusCode}`);
  const settings = await t.app.inject({ url: '/settings', headers: { cookie } });
  const csrf = /X-CSRF-Token":"([^"]+)"/.exec(settings.body)?.[1];
  if (!csrf) throw new Error('no csrf token on /settings');
  return {
    cookie,
    csrf,
    get: (url) => t.app.inject({ url, headers: { cookie } }),
    post: (url, fields = {}, withToken = true) =>
      t.app.inject({
        method: 'POST',
        url,
        headers: { ...FORM, cookie },
        payload: form(withToken ? { ...fields, _csrf: csrf } : fields),
      }),
  };
}
