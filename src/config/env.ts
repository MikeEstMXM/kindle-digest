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
  /** Port of the separate, login-free Kindle page. 0 disables it. */
  kindlePort: number;
  /** Where published .mobi issues live; this is all the Kindle page can see. */
  kindleDir: string;
  /** Issues kept per folder on the Kindle page. */
  kindleKeepIssues: number;
  /** calibre's CLI converter. */
  ebookConvertBin: string;
  /** Kill a conversion after this long. */
  convertTimeoutMs: number;
}

let cached: Env | undefined;

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
    kindlePort: Number(process.env.KINDLE_PORT ?? 3100),
    kindleDir: process.env.KINDLE_DIR ?? './data/kindle',
    kindleKeepIssues: Number(process.env.KINDLE_KEEP_ISSUES ?? 7),
    ebookConvertBin: process.env.EBOOK_CONVERT_BIN ?? 'ebook-convert',
    convertTimeoutMs: Number(process.env.CONVERT_TIMEOUT_MS ?? 20 * 60 * 1000),
  };
  return cached;
}

/** Test helper: clear the memoised env so a fresh load picks up new vars. */
export function resetEnvCache(): void {
  cached = undefined;
}
