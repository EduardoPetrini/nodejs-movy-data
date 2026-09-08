import { describe, expect, test } from 'vitest';
import type { MigrationEvent } from '@movy/core';
import { ReplayError, replayJournal } from '../../src/simulate';

const RECORDED_RUN_ID = 'recorded-run';
const NEW_RUN_ID = 'new-run';

function line(event: Record<string, unknown>): string {
  return JSON.stringify({ runId: RECORDED_RUN_ID, ...event });
}

async function* lines(...values: string[]): AsyncIterable<string> {
  for (const value of values) yield value;
}

/** Records what was asked for without ever waiting, so tests stay instant. */
function recordingSleep(): { calls: number[]; sleep: (ms: number) => Promise<void> } {
  const calls: number[] = [];
  return {
    calls,
    sleep: (ms: number) => {
      calls.push(ms);
      return Promise.resolve();
    },
  };
}

function collector(): { events: MigrationEvent[]; emit: (e: MigrationEvent) => void } {
  const events: MigrationEvent[] = [];
  return { events, emit: (e) => events.push(e) };
}

const STARTED = line({
  type: 'run_started',
  mode: 'full',
  source: { engine: 'postgres', database: 'src' },
  target: { engine: 'postgres', database: 'dst' },
  seq: 1,
  at: '2026-09-07T21:29:52.000Z',
});
const FINISHED = line({
  type: 'run_finished',
  status: 'succeeded',
  durationMs: 407,
  seq: 2,
  at: '2026-09-07T21:29:54.000Z',
});
const TRAILING_PROGRESS = line({
  type: 'overall_progress',
  rowsDone: 10,
  rowsTotal: 10,
  pct: 100,
  tablesDone: 1,
  tablesTotal: 1,
  seq: 3,
  at: '2026-09-07T21:29:54.000Z',
});

describe('replayJournal', () => {
  test('rewrites runId and at, but preserves the recorded seq', async () => {
    const { events, emit } = collector();
    const { sleep } = recordingSleep();

    const status = await replayJournal(lines(STARTED, FINISHED), {
      runId: NEW_RUN_ID,
      speed: 1,
      emit,
      signal: new AbortController().signal,
      sleep,
      now: () => Date.parse('2027-01-01T00:00:00.000Z'),
    });

    expect(status).toBe('succeeded');
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(events.every((e) => e.runId === NEW_RUN_ID)).toBe(true);
    expect(events.every((e) => e.at === '2027-01-01T00:00:00.000Z')).toBe(true);
  });

  test('sleeps for the recorded gap, divided by speed', async () => {
    const { emit } = collector();
    const { calls, sleep } = recordingSleep();

    await replayJournal(lines(STARTED, FINISHED), {
      runId: NEW_RUN_ID,
      speed: 2,
      emit,
      signal: new AbortController().signal,
      sleep,
    });

    // First event has no predecessor; the 2000ms gap replays at 2x.
    expect(calls).toEqual([0, 1000]);
  });

  test('compresses a pause longer than the cap, so a replay never looks hung', async () => {
    const longGap = line({
      type: 'log',
      level: 'info',
      message: 'slow index build',
      seq: 2,
      at: '2026-09-07T22:29:52.000Z',
    });
    const { emit } = collector();
    const { calls, sleep } = recordingSleep();

    await replayJournal(lines(STARTED, longGap), {
      runId: NEW_RUN_ID,
      speed: 1,
      emit,
      signal: new AbortController().signal,
      sleep,
    });

    expect(calls[1]).toBe(5000);
  });

  test('takes the terminal status from run_finished even when it is not the last line', async () => {
    const { events, emit } = collector();
    const { sleep } = recordingSleep();

    const status = await replayJournal(lines(STARTED, FINISHED, TRAILING_PROGRESS), {
      runId: NEW_RUN_ID,
      speed: 1,
      emit,
      signal: new AbortController().signal,
      sleep,
    });

    expect(status).toBe('succeeded');
    expect(events).toHaveLength(3);
    expect(events[2]!.type).toBe('overall_progress');
  });

  test('skips blank lines', async () => {
    const { events, emit } = collector();
    const { sleep } = recordingSleep();

    await replayJournal(lines(STARTED, '', '   ', FINISHED), {
      runId: NEW_RUN_ID,
      speed: 1,
      emit,
      signal: new AbortController().signal,
      sleep,
    });

    expect(events).toHaveLength(2);
  });

  test('reports a truncated recording rather than inventing a success', async () => {
    const { events, emit } = collector();
    const { sleep } = recordingSleep();

    const status = await replayJournal(lines(STARTED), {
      runId: NEW_RUN_ID,
      speed: 1,
      emit,
      signal: new AbortController().signal,
      sleep,
    });

    expect(status).toBe('failed');
    const terminal = events.at(-1)!;
    expect(terminal.type).toBe('run_finished');
    expect(terminal).toMatchObject({ status: 'failed', seq: 2 });
  });

  test('emits a cancelled terminal event when aborted mid-replay', async () => {
    const { events, emit } = collector();
    const controller = new AbortController();

    const status = await replayJournal(lines(STARTED, FINISHED), {
      runId: NEW_RUN_ID,
      speed: 1,
      emit,
      signal: controller.signal,
      // Abort while waiting out the gap before the second event.
      sleep: async (ms: number) => {
        if (ms > 0) controller.abort();
      },
    });

    expect(status).toBe('cancelled');
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: 'run_finished', status: 'cancelled', seq: 2 });
  });

  test('rejects a malformed line instead of silently skipping it', async () => {
    const { emit } = collector();
    const { sleep } = recordingSleep();

    await expect(
      replayJournal(lines(STARTED, 'not json'), {
        runId: NEW_RUN_ID,
        speed: 1,
        emit,
        signal: new AbortController().signal,
        sleep,
      })
    ).rejects.toThrow(ReplayError);
  });

  test('rejects a line missing seq, which the host needs as its cursor', async () => {
    const { emit } = collector();
    const { sleep } = recordingSleep();

    await expect(
      replayJournal(lines(line({ type: 'log', level: 'info', message: 'x', at: STARTED })), {
        runId: NEW_RUN_ID,
        speed: 1,
        emit,
        signal: new AbortController().signal,
        sleep,
      })
    ).rejects.toThrow(/"seq" must be a positive integer/);
  });

  test('rejects a non-positive speed', async () => {
    const { emit } = collector();

    await expect(
      replayJournal(lines(STARTED), {
        runId: NEW_RUN_ID,
        speed: 0,
        emit,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/speed must be a positive number/);
  });
});
