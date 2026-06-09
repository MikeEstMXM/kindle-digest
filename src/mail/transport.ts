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
  content: Buffer;
}

export function createTransport(cfg: SmtpConfig): Transporter {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
}

/**
 * Send one EPUB to the Kindle address. The `from` address MUST be on Amazon's
 * Approved Personal Document E-mail List or delivery is silently dropped.
 */
export async function sendEpub(
  transport: Transporter,
  cfg: SmtpConfig,
  to: string,
  subject: string,
  attachment: EpubAttachment,
): Promise<void> {
  await transport.sendMail({
    from: cfg.from,
    to,
    subject,
    text: 'Your daily digest is attached.',
    attachments: [
      {
        filename: attachment.filename,
        content: attachment.content,
        contentType: 'application/x-mobipocket-ebook',
      },
    ],
  });
}
