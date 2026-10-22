import { describe, it, expect, vi } from 'vitest';
import type { MigrationEvent } from '@movy/core';
import { EventWriter } from '../../server/runs/event-writer';
import type { ProjectionStore } from '../../server/runs/event-writer';
import type { Projection } from '../../server/runs/run-projection';

/**
 * `run_events` had no ceiling. `log` is the one unbounded event type — the
 * throttle coalesces progress, the plan bounds the structural events, but
 * `SinkLogger` puts every `logger.*` call on the stream and
 * `MigrateDataUseCase` logs once per 500-row batch — so the table grew with the
 * size of the database being migrated, forever.
 */

interface Applied { runId: string; projection: Projection }

function recorder() {
  const applied: Applied[] = [];
  const store: ProjectionStore = {
    async apply(runId, projection) {
      applied.push({ runId, projection });
    },
  };
  return { store, applied };
}

function manualTimer() {
  const pending: (() => void)[] = [];
  return {
    setTimer: (fn: () => void) => { pending.push(fn); return pending.length as unknown as NodeJS.Timeout; },
    clearTimer: () => {},
    fire: () => { pending.splice(0).forEach((fn) => fn()); },
  };
}

let seq = 0;
function logEvent(runId = 'r1'): MigrationEvent {
  seq += 1;
  return { type: 'log', level: 'info', message: `line ${seq}`, runId, seq, at: new Date().toISOString() };
}

function stepEvent(runId = 'r1'): MigrationEvent {
  seq += 1;
  return { type: 'step_started', stepId: 'migrate_data', ordinal: 5, runId, seq, at: new Date().toISOString() };
}

/**
 * Every event that reached the store, in order.
 *
 * Unwraps the projection's row back to the MigrationEvent it carries in
 * `payload`: the row's own columns are the indexed subset, and `message` is not
 * one of them.
 */
function stored(applied: Applied[]): MigrationEvent[] {
  return applied.flatMap((a) => a.projection.events.map((row) => row.payload as MigrationEvent));
}

describe('per-run log cap', () => {
  it('stops storing log events past the cap', async () => {
    const { store, applied } = recorder();
    const writer = new EventWriter(store, { maxBatch: 1, maxLogEventsPerRun: 3, ...manualTimer() });

    for (let i = 0; i < 10; i += 1) writer.push('r1', logEvent());
    await writer.flush();

    // Three: two ordinary lines and the notice that replaced the third.
    expect(stored(applied)).toHaveLength(3);
  });

  it('replaces the boundary event with a notice rather than leaving a hole', async () => {
    const { store, applied } = recorder();
    const writer = new EventWriter(store, { maxBatch: 1, maxLogEventsPerRun: 2, ...manualTimer() });

    const first = logEvent();
    const second = logEvent();
    writer.push('r1', first);
    writer.push('r1', second);
    await writer.flush();

    const events = stored(applied);
    // Same seq as the event it replaced: a log pane that simply stopped would
    // read as a hang, and the client requires monotonic seq, not contiguous.
    expect(events[1]!.seq).toBe(second.seq);
    expect((events[1] as { level: string }).level).toBe('warn');
    expect((events[1] as { message: string }).message).toMatch(/no longer being recorded/);
  });

  it('never caps structural events, whatever the log volume', async () => {
    const { store, applied } = recorder();
    const writer = new EventWriter(store, { maxBatch: 1, maxLogEventsPerRun: 1, ...manualTimer() });

    for (let i = 0; i < 5; i += 1) writer.push('r1', logEvent());
    const step = stepEvent();
    writer.push('r1', step);
    await writer.flush();

    // Dropping a step or a run_finished would leave the run permanently
    // unsettled with a half-drawn timeline — far worse than a large table.
    expect(stored(applied).some((e) => e.seq === step.seq)).toBe(true);
  });

  it('reports the cap once, not once per dropped event', async () => {
    const onTruncated = vi.fn();
    const { store } = recorder();
    const writer = new EventWriter(store, {
      maxBatch: 1, maxLogEventsPerRun: 2, onTruncated, ...manualTimer(),
    });

    for (let i = 0; i < 20; i += 1) writer.push('r1', logEvent());
    await writer.flush();

    expect(onTruncated).toHaveBeenCalledTimes(1);
  });

  it('counts each run separately', async () => {
    const { store, applied } = recorder();
    const writer = new EventWriter(store, { maxBatch: 1, maxLogEventsPerRun: 2, ...manualTimer() });

    writer.push('r1', logEvent('r1'));
    writer.push('r1', logEvent('r1'));
    writer.push('r2', logEvent('r2'));
    await writer.flush();

    // One noisy run must not silence a quiet one.
    expect(applied.filter((a) => a.runId === 'r2')).toHaveLength(1);
  });

  it('forgets a settled run, so the tally map does not grow for the process lifetime', async () => {
    const { store, applied } = recorder();
    const writer = new EventWriter(store, { maxBatch: 1, maxLogEventsPerRun: 2, ...manualTimer() });

    writer.push('r1', logEvent());
    writer.push('r1', logEvent());
    writer.forget('r1');
    writer.push('r1', logEvent());
    await writer.flush();

    // Counting restarts, which is the same thing that happens across a host
    // restart when the journal is replayed — and duplicate rows are discarded
    // by the (run_id, seq) key anyway.
    const last = stored(applied).at(-1)!;
    expect((last as { message: string }).message).toMatch(/^line /);
  });

  it('leaves runs below the cap completely untouched', async () => {
    const { store, applied } = recorder();
    const writer = new EventWriter(store, { maxBatch: 1, maxLogEventsPerRun: 1000, ...manualTimer() });

    for (let i = 0; i < 25; i += 1) writer.push('r1', logEvent());
    await writer.flush();

    expect(stored(applied)).toHaveLength(25);
    expect(stored(applied).every((e) => (e as { message: string }).message.startsWith('line '))).toBe(true);
  });
});
