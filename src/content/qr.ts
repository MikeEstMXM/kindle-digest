import QRCode from 'qrcode';

export interface QrOptions {
  /** Output edge length in px. Spec minimum is 200 for e-ink scannability. */
  size?: number;
}

const MIN_SIZE = 200;

/**
 * Generate a QR code PNG for an article's source URL. Enforces the 200×200
 * minimum and uses error-correction level M (good for e-ink contrast).
 */
export async function generateQrPng(url: string, opts: QrOptions = {}): Promise<Buffer> {
  const size = Math.max(MIN_SIZE, opts.size ?? MIN_SIZE);
  return QRCode.toBuffer(url, {
    type: 'png',
    errorCorrectionLevel: 'M',
    width: size,
    margin: 2,
    color: { dark: '#000000ff', light: '#ffffffff' },
  });
}

/** Decode helper is provided in tests via jsqr-like checks against the URL. */
export function qrMinSize(): number {
  return MIN_SIZE;
}
