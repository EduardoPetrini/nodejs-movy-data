import * as fs from 'node:fs';
import * as readline from 'node:readline';
import type { MigrationEvent } from '@movy/core';

/**
 * Reads a runner's journal forward from a `seq` cursor.
 *
 * This is what makes a host restart a non-event. The runner is forked
 * `detached` and keeps writing while Nitro is down; on boot the host reads this
 * file from the last `seq` it durably stored and catches up. IPC is the fast
 * path, never the record — so a gap in IPC is not a gap in the run.
 *
 * Streamed line by line: a long run's journal is far larger than one batch and
 * must never be held in memory whole.
 */
export async function readJournalAfter(
  journalPath: string,
  afterSeq: number,
  onEvent: (event: MigrationEvent) => void
): Promise<{ read: number; lastSeq: number; malformed: number }> {
  if (!fs.existsSync(journalPath)) return { read: 0, lastSeq: afterSeq, malformed: 0 };

  const lines = readline.createInterface({
    input: fs.createReadStream(journalPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let read = 0;
  let malformed = 0;
  let lastSeq = afterSeq;

  try {
    for await (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      const event = parseEvent(trimmed);
      if (event === null) {
        // A half-written last line is the normal shape of a crash, not a
        // corrupt journal. Count it and keep going; the runner will rewrite
        // nothing, but every intact line before it is still recoverable.
        malformed += 1;
        continue;
      }

      if (event.seq <= afterSeq) continue;
      read += 1;
      lastSeq = Math.max(lastSeq, event.seq);
      onEvent(event);
    }
  } finally {
    lines.close();
  }

  return { read, lastSeq, malformed };
}

/** Is the process that owned this run still alive? */
export function isProcessAlive(pid: number | null): boolean {
  if (pid === null || pid <= 0) return false;
  try {
    // Signal 0 performs the permission and existence check without delivering.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to someone else — alive, for our
    // purposes. Only ESRCH means gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseEvent(line: string): MigrationEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const candidate = parsed as Partial<MigrationEvent>;
  if (
    typeof candidate.type !== 'string' ||
    typeof candidate.runId !== 'string' ||
    typeof candidate.at !== 'string' ||
    typeof candidate.seq !== 'number' ||
    !Number.isInteger(candidate.seq)
  ) {
    return null;
  }
  return parsed as MigrationEvent;
}
