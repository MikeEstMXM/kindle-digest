import nodemailer, { type Transporter } from 'nodemailer';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

export interface EpubAttachment {
  filename: string;
  /** Path on disk. Streamed by nodemailer — never loaded into the heap. */
  path: string;
}

export interface SendOutcome {
  messageId: string | null;
  accepted: string[];
}

/**
 * Explicit timeouts matter here: nodemailer's defaults allow a 2-minute
 * connect and a 10-minute idle socket, so a wedged SMTP server could stall a
 * whole delivery run with nothing in the logs.
 */
export function createTransport(cfg: SmtpConfig): Transporter {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    connectionTimeout: 30_000,
    greetingTimeout: 15_000,
    socketTimeout: 120_000,
    dnsTimeout: 30_000,
  });
}

export class SmtpRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmtpRejectedError';
  }
}

/**
 * Send one EPUB to the Kindle address and confirm the server took it.
 *
 * The `from` address MUST be on Amazon's Approved Personal Document E-mail
 * List or delivery is silently dropped — that failure is invisible to SMTP and
 * cannot be detected here.
 */
export async function sendEpub(
  transport: Transporter,
  cfg: SmtpConfig,
  to: string,
  subject: string,
  attachment: EpubAttachment,
): Promise<SendOutcome> {
  const info = await transport.sendMail({
    from: cfg.from,
    to,
    subject,
    text: 'Your daily digest is attached.',
    attachments: [
      {
        filename: attachment.filename,
        path: attachment.path,
        contentType: 'application/epub+zip',
      },
    ],
  });

  // The result used to be discarded, so a server that accepted the envelope
  // but rejected the recipient looked identical to success.
  const accepted = (info.accepted ?? []).map(String);
  const rejected = (info.rejected ?? []).map(String);
  if (rejected.length > 0) {
    throw new SmtpRejectedError(`SMTP rejected recipient(s): ${rejected.join(', ')}`);
  }
  if (accepted.length === 0) {
    throw new SmtpRejectedError('SMTP accepted no recipients');
  }

  return { messageId: info.messageId ?? null, accepted };
}

/** Send a plain-text message (used for failure alerts). */
export async function sendPlainMail(
  transport: Transporter,
  cfg: SmtpConfig,
  to: string,
  subject: string,
  text: string,
): Promise<void> {
  await transport.sendMail({ from: cfg.from, to, subject, text });
}

export type SmtpErrorKind = 'transient' | 'permanent';

/** SMTP/network error codes that will never succeed on retry. */
const PERMANENT_CODES = new Set(['EAUTH', 'EENVELOPE']);
const TRANSIENT_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKET',
  'ECONNECTION',
  'ECONNRESET',
  'ECONNREFUSED',
  'EDNS',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ESTREAM',
]);

/**
 * Decide whether a failed send is worth retrying. Getting this wrong is
 * expensive in both directions: retrying a bad password wastes the whole
 * backoff schedule before alerting, while giving up on a transient network
 * blip loses the digest.
 */
export function classifySmtpError(err: unknown): SmtpErrorKind {
  const code = (err as { code?: string } | null)?.code;
  if (code && PERMANENT_CODES.has(code)) return 'permanent';
  if (code && TRANSIENT_CODES.has(code)) return 'transient';

  // A rejected recipient is a configuration problem, not a blip.
  if (err instanceof SmtpRejectedError) return 'permanent';

  // Fall back to the SMTP reply code: 4xx is "try again", 5xx is fatal.
  const responseCode = (err as { responseCode?: number } | null)?.responseCode;
  if (typeof responseCode === 'number') {
    return responseCode >= 500 ? 'permanent' : 'transient';
  }

  // Unknown failures are treated as transient so a one-off doesn't lose the
  // digest; the attempt cap still bounds how long we keep trying.
  return 'transient';
}
