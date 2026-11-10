import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import JSZip from 'jszip';
import { toPeriodicalOpf } from './opf2.js';

/** Conversion failure that will fail the same way again (no point retrying). */
export class PermanentConversionError extends Error {}

/**
 * Write the conversion copy of an EPUB: identical except content.opf is the
 * OPF 2 periodical variant (see toPeriodicalOpf). The app's own EPUB is left
 * untouched, because the email path still sends it as-is.
 */
export async function writePeriodicalEpub(
  srcEpub: string,
  destEpub: string,
  folder: string,
): Promise<void> {
  const zip = await JSZip.loadAsync(await readFile(srcEpub));
  const container = await zip.file('META-INF/container.xml')?.async('string');
  const opfPath = container && /full-path="([^"]+)"/.exec(container)?.[1];
  if (!opfPath) throw new PermanentConversionError('EPUB has no content.opf (container.xml)');
  const opfFile = zip.file(opfPath);
  if (!opfFile) throw new PermanentConversionError(`EPUB is missing ${opfPath}`);

  try {
    zip.file(opfPath, toPeriodicalOpf(await opfFile.async('string'), folder));
  } catch (err) {
    throw new PermanentConversionError(err instanceof Error ? err.message : String(err));
  }
  // `mimetype` must stay stored; re-adding keeps its place at the front.
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

  await pipeline(
    zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE' }),
    createWriteStream(destEpub),
  );
}

export interface EbookConvertOptions {
  /** Path or name of calibre's `ebook-convert`. */
  bin: string;
  timeoutMs: number;
}

/**
 * Run calibre as a separate CLI process (never imported — keeps its GPL code
 * out of this app). `--share-not-sync` omits the ASIN (EXTH 113); with it the
 * Kindle shows no cover thumbnail for a side-loaded periodical.
 */
export function runEbookConvert(
  input: string,
  output: string,
  opts: EbookConvertOptions,
): Promise<void> {
  const args = [input, output, '--output-profile', 'kindle', '--share-not-sync'];
  return new Promise((resolve, reject) => {
    // calibre is a separate program with its own bundled libraries; the app's
    // jemalloc preload is tuned for sharp and not something to inflict on it.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      QT_QPA_PLATFORM: process.env.QT_QPA_PLATFORM ?? 'offscreen',
    };
    delete env.LD_PRELOAD;
    // Own process group, so a timeout can kill calibre's helper processes too.
    const child = spawn(opts.bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env, detached: true });
    // Keep only the tail: calibre prints a progress line per step.
    let tail = '';
    const keep = (chunk: Buffer): void => {
      tail = (tail + chunk.toString('utf8')).slice(-3000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, opts.timeoutMs);

    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        err.code === 'ENOENT'
          ? new PermanentConversionError(
              `ebook-convert not found (${opts.bin}); install calibre or set EBOOK_CONVERT_BIN`,
            )
          : err,
      );
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new PermanentConversionError(
            `ebook-convert timed out after ${Math.round(opts.timeoutMs / 1000)}s`,
          ),
        );
      } else if (code === 0) {
        resolve();
      } else {
        const why = signal ? `killed by ${signal} (out of memory?)` : `exit code ${code}`;
        reject(new Error(`ebook-convert failed: ${why}\n${tail.trim()}`));
      }
    });
  });
}
