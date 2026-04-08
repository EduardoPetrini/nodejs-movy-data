import * as path from 'path';
import * as fs from 'fs';

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

export function resolveWorkerPath(filename: string): string {
  const distPath = path.resolve(__dirname, '../../dist/infrastructure/migration', filename.replace(/\.ts$/, '.js'));
  const isDist = process.env.NODE_ENV === 'production' || fs.existsSync(distPath);
  if (isDist) {
    return distPath;
  }
  return path.resolve(__dirname, '../infrastructure/migration', filename);
}
