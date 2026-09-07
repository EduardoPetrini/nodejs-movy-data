import * as path from 'path';

/**
 * Resolve the directory log files are written to. Always absolute.
 *
 * The CLI previously built a cwd-relative 'logs/...' path inline, which meant a
 * process started from a different directory scattered its logs. A long-running
 * server needs this pinned.
 */
export function resolveLogDir(explicit?: string): string {
  return path.resolve(explicit ?? process.env.MOVY_LOG_DIR ?? path.join(process.cwd(), 'logs'));
}

/** movy_<date>_<time>_<source>_to_<dest>.log, under an absolute directory. */
export function buildLogFilePath(sourceDb: string, destDb: string, dir?: string): string {
  const now = new Date();
  const datePart = now.toISOString().slice(0, 10);
  const timePart = now.toISOString().slice(11, 19).replace(/:/g, '-');
  const safeSrc = sourceDb.replace(/[^a-z0-9_-]/gi, '_');
  const safeDst = destDb.replace(/[^a-z0-9_-]/gi, '_');
  return path.join(resolveLogDir(dir), `movy_${datePart}_${timePart}_${safeSrc}_to_${safeDst}.log`);
}
