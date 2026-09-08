import * as fs from 'fs';
import * as readline from 'readline';
import type { MigrationEvent, RunTerminalStatus } from '@movy/core';

/**
 * A recorded pause longer than this is compressed. Real runs contain idle gaps
 * — a slow CREATE INDEX, an operator-paced re-record — and replaying one
 * faithfully would look to a viewer exactly like a hung simulator.
 */
const MAX_GAP_MS = 5_000;

export class ReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayError';
  }
}

export interface ReplayOptions {
  /** The NEW run's id. Recorded ids are overwritten so a replay is a real run downstream. */
  readonly runId: string;
  /** Divides the recorded gaps: 2 is twice as fast, 0.05 is twenty times slower. */
  readonly speed: number;
  readonly emit: (event: MigrationEvent) => void;
  readonly signal: AbortSignal;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => number;
}

/**
 * Replays a recorded journal as if it were happening now.
 *
 * `seq` is preserved exactly as recorded — it is the host's replay cursor and
 * the recording already guarantees it is gapless. `runId` and `at` are
 * rewritten, so everything downstream of the runner (journal, IPC, sockets,
 * projections) handles a simulated run through the identical code path as a
 * real one. That is the whole point: the web timeline is built and tested
 * against this before a database is involved.
 */
export async function replayJournal(
  lines: AsyncIterable<string>,
  options: ReplayOptions
): Promise<RunTerminalStatus> {
  const { runId, speed, emit, signal } = options;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;

  if (!Number.isFinite(speed) || speed <= 0) {
    throw new ReplayError('speed must be a positive number');
  }

  let previousRecordedAt: number | null = null;
  let maxSeq = 0;
  let terminal: RunTerminalStatus | null = null;
  let lineNumber = 0;

  for await (const line of lines) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const recorded = parseEvent(trimmed, lineNumber);
    const recordedAt = Date.parse(recorded.at);
    if (Number.isNaN(recordedAt)) {
      throw new ReplayError(`line ${lineNumber}: "at" is not a valid timestamp`);
    }

    const gap = previousRecordedAt === null ? 0 : recordedAt - previousRecordedAt;
    previousRecordedAt = recordedAt;
    await sleep(Math.min(Math.max(gap, 0) / speed, MAX_GAP_MS), signal);

    if (signal.aborted) {
      emit(cancelledEvent(runId, maxSeq + 1, now));
      return 'cancelled';
    }

    maxSeq = Math.max(maxSeq, recorded.seq);
    emit({ ...recorded, runId, at: new Date(now()).toISOString() });

    // Taken from wherever run_finished appears rather than from the last line.
    // It is NOT always last: the producer's throttle flushes its held progress
    // sample on close, so a trailing overall_progress after the terminal event
    // is normal and must not change the outcome.
    if (recorded.type === 'run_finished') terminal = recorded.status;
  }

  if (terminal !== null) return terminal;

  // A journal with no terminal event is a truncated recording. Say so on the
  // stream instead of returning a status the fixture never claimed.
  emit({
    type: 'run_finished',
    status: 'failed',
    durationMs: 0,
    error: { name: 'ReplayError', message: 'recorded journal ended without a run_finished event' },
    runId,
    seq: maxSeq + 1,
    at: new Date(now()).toISOString(),
  });
  return 'failed';
}

/** Streams a journal line by line so a large recording is never held in memory. */
export function readJournalLines(filePath: string): AsyncIterable<string> {
  return readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
}

function cancelledEvent(runId: string, seq: number, now: () => number): MigrationEvent {
  return {
    type: 'run_finished',
    status: 'cancelled',
    durationMs: 0,
    runId,
    seq,
    at: new Date(now()).toISOString(),
  };
}

function parseEvent(line: string, lineNumber: number): MigrationEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new ReplayError(`line ${lineNumber}: not valid JSON`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new ReplayError(`line ${lineNumber}: not an object`);
  }

  const candidate = parsed as Partial<MigrationEvent>;
  if (typeof candidate.type !== 'string') {
    throw new ReplayError(`line ${lineNumber}: missing "type"`);
  }
  if (typeof candidate.seq !== 'number' || !Number.isInteger(candidate.seq) || candidate.seq < 1) {
    throw new ReplayError(`line ${lineNumber}: "seq" must be a positive integer`);
  }
  if (typeof candidate.at !== 'string') {
    throw new ReplayError(`line ${lineNumber}: missing "at"`);
  }
  return parsed as MigrationEvent;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}
