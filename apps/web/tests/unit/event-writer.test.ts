import { describe, it, expect, vi } from 'vitest';
import type { MigrationEvent } from '@movy/core';
import { EventWriter } from '../../server/runs/event-writer';
import type { ProjectionStore } from '../../server/runs/event-writer';
import type { Projection } from '../../server/runs/run-projection';

interface Applied { runId: string; projection: Projection }

function recorder(behaviour?: (call: number) => Promise<void>) {
  const applied: Applied[] = [];
  let calls = 0;
  const store: ProjectionStore = {
    async apply(runId, projection) {
      calls += 1;
      applied.push({ runId, projection });
      if (behaviour) await behaviour(calls);
    },
  };
  return { store, applied };
}

let seq = 0;
function logEvent(runId = 'r1'): MigrationEvent {
  seq += 1;
  return { type: 'log', level: 'info', message: `m${seq}`, runId, seq, at: new Date().toISOString() };
}

/** Timer control, so batching is asserted on rules rather than on wall clock. */
function manualTimer() {
  const pending: (() => void)[] = [];
  return {
    setTimer: (fn: () => void) => { pending.push(fn); return pending.length as unknown as NodeJS.Timeout; },
    clearTimer: () => {},
    fire: () => { const fns = pending.splice(0); fns.forEach((fn) => fn()); },
    get armed() { return pending.length; },
  };
}

describe('EventWriter', () => {
  it('holds events until the batch fills, then writes once', async () => {
    const { store, applied } = recorder();
    const timer = manualTimer();
    const writer = new EventWriter(store, { maxBatch: 3, ...timer });

    writer.push('r1', logEvent());
    writer.push('r1', logEvent());
    expect(applied).toHaveLength(0);

    writer.push('r1', logEvent());
    await writer.flush();

    expect(applied).toHaveLength(1);
    expect(applied[0].projection.events).toHaveLength(3);
  });

  it('writes a partial batch when the timer fires, so a quiet run still lands', async () => {
    const { store, applied } = recorder();
    const timer = manualTimer();
    const writer = new EventWriter(store, { maxBatch: 100, ...timer });

    writer.push('r1', logEvent());
    expect(timer.armed).toBe(1);
    timer.fire();
    await writer.flush();

    expect(applied).toHaveLength(1);
    expect(applied[0].projection.events).toHaveLength(1);
  });

  it('keeps one buffer per run, so two live runs never merge', async () => {
    const { store, applied } = recorder();
    const writer = new EventWriter(store, { maxBatch: 100, ...manualTimer() });

    writer.push('r1', logEvent('r1'));
    writer.push('r2', logEvent('r2'));
    await writer.flush();

    expect(applied.map((a) => a.runId).sort()).toEqual(['r1', 'r2']);
    expect(applied.every((a) => a.projection.events.length === 1)).toBe(true);
  });

  it('flushes only the named run when given an id', async () => {
    const { store, applied } = recorder();
    const writer = new EventWriter(store, { maxBatch: 100, ...manualTimer() });

    writer.push('r1', logEvent('r1'));
    writer.push('r2', logEvent('r2'));
    await writer.flush('r1');

    expect(applied.map((a) => a.runId)).toEqual(['r1']);
  });

  it('never runs two writes for the same run concurrently', async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    const { store, applied } = recorder(async () => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    });
    const writer = new EventWriter(store, { maxBatch: 1, ...manualTimer() });

    writer.push('r1', logEvent());
    writer.push('r1', logEvent());
    writer.push('r1', logEvent());
    await writer.flush();

    expect(maxConcurrent).toBe(1);
    expect(applied.length).toBeGreaterThan(1);
  });

  it('swallows a store failure rather than killing the process supervising a run', async () => {
    const onError = vi.fn();
    const store: ProjectionStore = { apply: () => Promise.reject(new Error('db down')) };
    const writer = new EventWriter(store, { maxBatch: 1, onError, ...manualTimer() });

    writer.push('r1', logEvent());
    await expect(writer.flush()).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0].message).toBe('db down');
    expect(onError.mock.calls[0][1]).toBe('r1');
  });

  it('is a no-op when there is nothing held', async () => {
    const { store, applied } = recorder();
    const writer = new EventWriter(store, manualTimer());
    await writer.flush();
    await writer.flush('unknown-run');
    expect(applied).toHaveLength(0);
  });

  it('announces a batch only after it is durably stored', async () => {
    // The ordering the socket fan-out depends on. Broadcasting first would
    // leave every event between a client's snapshot read and the next flush
    // invisible to it — a hole the client cannot even detect.
    const order: string[] = [];
    const store: ProjectionStore = {
      async apply() {
        order.push('stored');
        await new Promise((r) => setTimeout(r, 5));
        order.push('stored:done');
      },
    };
    const writer = new EventWriter(store, {
      maxBatch: 1,
      onFlushed: () => order.push('broadcast'),
      ...manualTimer(),
    });

    writer.push('r1', logEvent());
    await writer.flush();

    expect(order).toEqual(['stored', 'stored:done', 'broadcast']);
  });

  it('does not announce a batch that failed to store', async () => {
    // Otherwise a reconnecting client asks for events past a cursor the
    // database never advanced to.
    const onFlushed = vi.fn();
    const store: ProjectionStore = { apply: () => Promise.reject(new Error('db down')) };
    const writer = new EventWriter(store, { maxBatch: 1, onFlushed, onError: () => {}, ...manualTimer() });

    writer.push('r1', logEvent());
    await writer.flush();

    expect(onFlushed).not.toHaveBeenCalled();
  });

  it('passes the folded projection to the broadcaster, not the raw batch', async () => {
    const seen: unknown[] = [];
    const writer = new EventWriter(
      { async apply() {} },
      { maxBatch: 2, onFlushed: (_runId, projection) => seen.push(projection), ...manualTimer() }
    );

    writer.push('r1', logEvent());
    writer.push('r1', logEvent());
    await writer.flush();

    expect(seen).toHaveLength(1);
    expect((seen[0] as { events: unknown[] }).events).toHaveLength(2);
  });

  it('waits for a write that is already in flight, not just for buffered events', async () => {
    // Regression: flush() looked only at the buffer, so it resolved instantly
    // whenever a write was already running. RunManager awaits flush() before
    // settling a run — which meant a run could be marked finished before its
    // last events were stored.
    let resolveStore: (() => void) | undefined;
    let done = false;
    const store: ProjectionStore = {
      apply: () => new Promise<void>((resolve) => {
        resolveStore = () => { done = true; resolve(); };
      }),
    };
    const writer = new EventWriter(store, { maxBatch: 1, ...manualTimer() });

    writer.push('r1', logEvent()); // starts the write; buffer is now empty
    const flushed = writer.flush('r1');

    let settledEarly = false;
    void flushed.then(() => { settledEarly = !done; });
    await new Promise((r) => setTimeout(r, 10));
    expect(settledEarly).toBe(false);

    resolveStore!();
    await flushed;
    expect(done).toBe(true);
  });

  it('drains on close', async () => {
    const { store, applied } = recorder();
    const writer = new EventWriter(store, { maxBatch: 100, ...manualTimer() });
    writer.push('r1', logEvent());
    await writer.close();
    expect(applied).toHaveLength(1);
  });
});
