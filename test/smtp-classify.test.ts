import { describe, it, expect } from 'vitest';
import { classifySmtpError, SmtpRejectedError } from '../src/mail/transport.js';

function withCode(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe('classifySmtpError', () => {
  it('treats network and timeout failures as transient', () => {
    for (const code of ['ETIMEDOUT', 'ESOCKET', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN']) {
      expect(classifySmtpError(withCode(code))).toBe('transient');
    }
  });

  it('treats auth and envelope failures as permanent so retries are not wasted', () => {
    expect(classifySmtpError(withCode('EAUTH'))).toBe('permanent');
    expect(classifySmtpError(withCode('EENVELOPE'))).toBe('permanent');
  });

  it('treats a rejected recipient as permanent — that is misconfiguration', () => {
    expect(classifySmtpError(new SmtpRejectedError('SMTP rejected recipient(s): x@y'))).toBe(
      'permanent',
    );
  });

  it('uses the SMTP reply code when there is no error code', () => {
    expect(classifySmtpError({ responseCode: 421 })).toBe('transient');
    expect(classifySmtpError({ responseCode: 450 })).toBe('transient');
    expect(classifySmtpError({ responseCode: 535 })).toBe('permanent');
    expect(classifySmtpError({ responseCode: 550 })).toBe('permanent');
  });

  it('defaults unknown failures to transient so a one-off does not lose the digest', () => {
    expect(classifySmtpError(new Error('something odd'))).toBe('transient');
    expect(classifySmtpError(null)).toBe('transient');
    expect(classifySmtpError(undefined)).toBe('transient');
  });
});
