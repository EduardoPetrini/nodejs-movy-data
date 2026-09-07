import * as path from 'path';
import * as fs from 'fs';

/**
 * Loads a .env file into process.env.
 * Skips silently if the file does not exist.
 * Already-set variables are NOT overwritten (same behaviour as dotenv).
 */
export function loadEnvFile(filePath = path.resolve(process.cwd(), '.env')): void {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, 'utf8');
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    const rawValue = line.slice(eqIndex + 1).trim();
    // Strip optional surrounding quotes (" or ')
    const value = rawValue.replace(/^(['"])(.*)\1$/, '$2');

    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

export function escapeIdentifier(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

export function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000,
  onRetry?: (attempt: number, error: Error, delayMs: number) => void
): Promise<T> {
  let lastError: Error = new Error('Unknown error');
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
        onRetry?.(attempt, lastError, delayMs);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

/**
 * Resolve the on-disk path of a worker script.
 *
 * Both `src/shared` and `dist/shared` sit beside their `infrastructure/migration`
 * sibling, so one relative expression is correct in each. The previous version
 * guessed at '../../dist/infrastructure/migration' and returned it unconditionally
 * under NODE_ENV=production — a path the build never produced once rootDir became
 * './' — so a production run spawned a Worker against a file that did not exist.
 *
 * MOVY_WORKER_DIR overrides resolution for hosts that relocate or bundle the
 * package. Throws naming every path tried rather than returning a bad one.
 */
export function resolveWorkerPath(filename: string): string {
  const jsName = filename.replace(/\.ts$/, '.js');
  const baseDir = process.env.MOVY_WORKER_DIR
    ? path.resolve(process.env.MOVY_WORKER_DIR)
    : path.resolve(__dirname, '../infrastructure/migration');

  const candidates = [path.join(baseDir, jsName), path.join(baseDir, filename)];
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) {
    throw new Error(
      `Worker script "${filename}" not found. Looked in: ${candidates.join(', ')}. ` +
        'Set MOVY_WORKER_DIR to the directory containing the compiled worker.'
    );
  }
  return found;
}

/**
 * Coerce a driver-supplied row estimate to a finite number.
 *
 * Database drivers return 64-bit integer columns as STRINGS to avoid losing
 * precision: node-pg does this for `reltuples::bigint`, and mysql2 / mssql do
 * the same for BIGINT depending on configuration. `IDatabaseConnection.query<T>`
 * is an unchecked cast at the driver boundary, so a `Map<string, number>` could
 * silently end up holding strings — and `0 + "20000"` is `"020000"`, which made
 * every overall-progress percentage collapse to 0.
 */
export function toRowCount(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
