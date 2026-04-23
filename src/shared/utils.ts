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

export function resolveWorkerPath(filename: string): string {
  const distPath = path.resolve(__dirname, '../../dist/infrastructure/migration', filename.replace(/\.ts$/, '.js'));
  const isDist = process.env.NODE_ENV === 'production' || fs.existsSync(distPath);
  if (isDist) {
    return distPath;
  }
  return path.resolve(__dirname, '../infrastructure/migration', filename);
}
