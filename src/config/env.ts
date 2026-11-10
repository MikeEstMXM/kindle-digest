import 'dotenv/config';
import { DEFAULT_BUILD_CONCURRENCY } from '../util/concurrency.js';

export interface Env {
  port: number;
  appBaseUrl: string;
  databasePath: string;
  smtp: {
    host?: string;
    port: number;
    secure: boolean;
    user?: string;
    pass?: string;
    from?: string;
  };
  defaults: {
    kindleEmail?: string;
    deliveryTime: string;
    timezone: string;
    /** 'download' (Kindle page, default) or 'email' (SMTP to @kindle.com). */
    deliveryMode: string;
  };
  fulltextMinChars: number;
  /** Directory built EPUBs are streamed to; lives on the Fly volume. */
  digestDir: string;
  /** Where delivery-failure alerts go. Defaults to the SMTP from-address. */
  alertEmail?: string;
  /** Attempts before a delivery is marked permanently failed. */
  deliveryMaxAttempts: number;
  /** Articles extracted/rendered in parallel during a build. */
  buildConcurrency: number;
  /** Where published .mobi issues live; served (behind login) at /issues. */
  kindleDir: string;
  /** Issues kept per folder. 0 (the default) keeps every issue. */
  kindleKeepIssues: number;
  /**
   * Key for the signed one-time tokens on the login/setup forms. Optional: when
   * unset a random one is made at startup (an open login page then needs a
   * reload after a restart). Sessions and CSRF tokens for logged-in pages are
   * random values in the database and do not use it.
   */
  sessionSecret?: string;
  /** calibre's CLI converter. */
  ebookConvertBin: string;
  /** Kill a conversion after this long. */
  convertTimeoutMs: number;
}

let cached: Env | undefined;

/**
 * Integer env var with a floor. A typo ("abc", "-3") falls back to the default
 * rather than becoming NaN, which would silently break pruning and timeouts.
 */
function intEnv(name: string, fallback: number, min: number): number {
  const n = Number(process.env[name]);
  return process.env[name] !== undefined && Number.isInteger(n) && n >= min ? n : fallback;
}

export function loadEnv(): Env {
  if (cached) return cached;
  cached = {
    port: Number(process.env.PORT ?? 3000),
    appBaseUrl: (process.env.APP_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
    databasePath: process.env.DATABASE_PATH ?? './data/kindle-digest.sqlite',
    smtp: {
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: (process.env.SMTP_SECURE ?? 'false') === 'true',
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      from: process.env.SMTP_FROM,
    },
    defaults: {
      kindleEmail: process.env.KINDLE_EMAIL,
      deliveryTime: process.env.DELIVERY_TIME ?? '06:30',
      timezone: process.env.TIMEZONE ?? 'America/New_York',
      deliveryMode: process.env.DELIVERY_MODE ?? 'download',
    },
    fulltextMinChars: Number(process.env.FULLTEXT_MIN_CHARS ?? 1800),
    // Default alongside the DB so it lands on the mounted volume in production.
    digestDir: process.env.DIGEST_DIR ?? './data/digests',
    alertEmail: process.env.ALERT_EMAIL ?? process.env.SMTP_FROM,
    deliveryMaxAttempts: Number(process.env.DELIVERY_MAX_ATTEMPTS ?? 5),
    buildConcurrency: Number(process.env.BUILD_CONCURRENCY ?? DEFAULT_BUILD_CONCURRENCY),
    kindleDir: process.env.KINDLE_DIR ?? './data/kindle',
    kindleKeepIssues: intEnv('KINDLE_KEEP_ISSUES', 0, 0),
    sessionSecret: process.env.SESSION_SECRET || undefined,
    ebookConvertBin: process.env.EBOOK_CONVERT_BIN ?? 'ebook-convert',
    convertTimeoutMs: intEnv('CONVERT_TIMEOUT_MS', 20 * 60 * 1000, 1000),
  };
  return cached;
}

/** Test helper: clear the memoised env so a fresh load picks up new vars. */
export function resetEnvCache(): void {
  cached = undefined;
}
