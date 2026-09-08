import * as fs from 'fs';
import * as path from 'path';
import type { MigrationEvent } from '@movy/core';

/**
 * The append-only NDJSON record of one run.
 *
 * This is the system of record, not a debugging artefact. The runner is forked
 * `detached`, so it keeps running while the host restarts; on boot the host
 * re-attaches by reading this file forward from the last `seq` it stored. IPC
 * is only the low-latency copy.
 *
 * Opened with 'a' so a re-exec appends rather than truncating: a truncated
 * journal is worse than a duplicated event, because `seq` makes duplicates
 * detectable and lost lines are not.
 */
export interface Journal {
  readonly path: string;
  write(event: MigrationEvent): void;
  close(): Promise<void>;
}

export function openJournal(filePath: string, onError: (err: Error) => void): Journal {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const stream = fs.createWriteStream(resolved, { flags: 'a' });

  // A journal that cannot be written is not a degraded run, it is an
  // unobservable one — main.ts turns this into a fatal exit rather than letting
  // the migration proceed unrecorded.
  stream.on('error', onError);

  return {
    path: resolved,
    write(event: MigrationEvent): void {
      stream.write(JSON.stringify(event) + '\n');
    },
    close(): Promise<void> {
      return new Promise<void>((resolve) => stream.end(resolve));
    },
  };
}
