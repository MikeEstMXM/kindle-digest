import type { Env } from '../config/env.js';
import type { SettingsRepo } from '../db/repositories.js';
import type { SmtpConfig } from '../mail/transport.js';

export type DeliveryMode = 'download' | 'email';

/** Anything unrecognised means the safe default: no email. */
export function parseDeliveryMode(value: string | undefined): DeliveryMode {
  return value === 'email' ? 'email' : 'download';
}

export interface EffectiveSettings {
  /** download = publish to the Kindle page; email = send via SMTP. */
  deliveryMode: DeliveryMode;
  kindleEmail?: string;
  deliveryTime: string;
  timezone: string;
  smtp: Partial<SmtpConfig>;
}

/** Merge env defaults with DB-stored settings (DB wins when present). */
export function resolveSettings(env: Env, repo: SettingsRepo): EffectiveSettings {
  const s = repo.all();
  return {
    deliveryMode: parseDeliveryMode(s.deliveryMode ?? env.defaults.deliveryMode),
    kindleEmail: s.kindleEmail ?? env.defaults.kindleEmail,
    deliveryTime: s.deliveryTime ?? env.defaults.deliveryTime,
    timezone: s.timezone ?? env.defaults.timezone,
    smtp: {
      host: s.smtpHost ?? env.smtp.host,
      port: s.smtpPort ? Number(s.smtpPort) : env.smtp.port,
      secure: s.smtpSecure ? s.smtpSecure === 'true' : env.smtp.secure,
      user: s.smtpUser ?? env.smtp.user,
      pass: s.smtpPass ?? env.smtp.pass,
      from: s.smtpFrom ?? env.smtp.from,
    },
  };
}

/** Validate that SMTP + Kindle settings are complete enough to send. */
export function assertDeliverable(s: EffectiveSettings): SmtpConfig & { to: string } {
  if (!s.kindleEmail) throw new Error('Kindle email is not configured (Settings page).');
  const { host, from } = s.smtp;
  if (!host || !from) {
    throw new Error('SMTP host and from-address must be configured (Settings page).');
  }
  return {
    host,
    port: s.smtp.port ?? 587,
    secure: s.smtp.secure ?? false,
    user: s.smtp.user,
    pass: s.smtp.pass,
    from,
    to: s.kindleEmail,
  };
}
