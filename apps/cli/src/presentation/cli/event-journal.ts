import * as fs from 'fs';
import * as path from 'path';
import { composeSink } from '@movy/core';
import type { MigrationEvent, MigrationRunContext } from '@movy/core';

/**
 * NDJSON recording of a run's MigrationEvent stream.
 *
 * Written to a file rather than stdout because this CLI is interactive:
 * prompts and the console logger already own stdout and would corrupt the
 * stream. The result is a faithful recording of a real migration, which makes
 * it usable as a replay fixture for the web timeline.
 */
export interface EventJournal {
  readonly path: string;
  readonly context: MigrationRunContext;
  close(): Promise<void>;
}

/**
 * Resolve `--json-events` / `--json-events=<path>` from argv.
 * Returns null when the flag is absent, or the path to write when present.
 */
export function parseJsonEventsFlag(argv: readonly string[], logFilePath: string): string | null {
  const flag = argv.find((arg) => arg === '--json-events' || arg.startsWith('--json-events='));
  if (flag === undefined) return null;

  const explicit = flag.includes('=') ? flag.slice(flag.indexOf('=') + 1).trim() : '';
  if (explicit.length > 0) return explicit;

  // Default: sit beside the log file for the same run.
  return logFilePath.replace(/\.log$/, '') + '.events.ndjson';
}

export function createEventJournal(filePath: string, runId: string): EventJournal {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const stream = fs.createWriteStream(filePath, { flags: 'a' });

  const sink = composeSink(runId, (event: MigrationEvent) => {
    stream.write(JSON.stringify(event) + '\n');
  });

  return {
    path: filePath,
    context: { runId, emit: sink },
    async close(): Promise<void> {
      // Drain any progress sample the throttle is still holding, so the last
      // number in the journal is the real one.
      sink.flush();
      await new Promise<void>((resolve) => stream.end(resolve));
    },
  };
}
