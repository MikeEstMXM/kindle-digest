import 'dotenv/config';

/**
 * Centralised environment configuration. Values here are process-level and
 * static; per-user mutable settings (Kindle email, delivery time, SMTP creds)
 * live in the database and are read via the settings repository.
 */
export interface Env {
  port: number;
  appBaseUrl: string;
  databasePath: string;
  credentialEncryptionKey: string;
  inoreader: {
    clientId: string;
    clientSecret: string;
    /** Derived: `${appBaseUrl}/auth/callback`. */
    redirectUri: string;
  };
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
  };
  fulltextMinChars: number;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;
  const appBaseUrl = (process.env.APP_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  cached = {
    port: Number(process.env.PORT ?? 3000),
    appBaseUrl,
    databasePath: process.env.DATABASE_PATH ?? './data/kindle-digest.sqlite',
    credentialEncryptionKey: req('CREDENTIAL_ENCRYPTION_KEY'),
    inoreader: {
      clientId: process.env.INOREADER_CLIENT_ID ?? '',
      clientSecret: process.env.INOREADER_CLIENT_SECRET ?? '',
      redirectUri: `${appBaseUrl}/auth/callback`,
    },
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
    },
    fulltextMinChars: Number(process.env.FULLTEXT_MIN_CHARS ?? 1800),
  };
  return cached;
}

/** Test helper: clear the memoised env so a fresh load picks up new vars. */
export function resetEnvCache(): void {
  cached = undefined;
}
