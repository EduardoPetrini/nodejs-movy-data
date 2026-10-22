import { describe, it, expect, vi } from 'vitest';
import { createSeqSink } from '../../../../src/application/events/seq-sink';
import { createThrottledSink } from '../../../../src/application/events/throttled-sink';
import { createSafeSink } from '../../../../src/application/events/safe-sink';
import { composeSink } from '../../../../src/application/events';
import { MigrationEvent } from '../../../../src/domain/types/events.types';

describe('createSeqSink', () => {
  it('stamps runId, a monotonic seq from 1, and a timestamp', () => {
    const out: MigrationEvent[] = [];
    const sink = createSeqSink('run-7', (e) => out.push(e), () => new Date('2026-01-01T00:00:00Z'));

    sink({ type: 'step_started', stepId: 'sync_schema', ordinal: 3 });
    sink({ type: 'step_started', stepId: 'migrate_data', ordinal: 5 });

    expect(out.map((e) => e.seq)).toEqual([1, 2]);
    expect(out.every((e) => e.runId === 'run-7')).toBe(true);
    expect(out[0].at).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('createThrottledSink', () => {
  it('coalesces table_progress for the same table within the interval', () => {
    let now = 1000;
    const out: MigrationEvent[] = [];
    const sink = createThrottledSink((e) => out.push(e as MigrationEvent), 250, () => now);

    // CrossDbDataMigrator fires once per 500-row batch; a large table would
    // otherwise produce thousands of events.
    for (let i = 1; i <= 20; i++) {
      sink({ type: 'table_progress', tableName: 'users', rowsDone: i * 500, rowsTotal: 100000, pct: i });
    }

    expect(out).toHaveLength(1);
    expect(out[0].type === 'table_progress' && out[0].rowsDone).toBe(500);
  });

  it('lets a second sample through once the interval has elapsed', () => {
    let now = 1000;
    const out: MigrationEvent[] = [];
    const sink = createThrottledSink((e) => out.push(e as MigrationEvent), 250, () => now);

    sink({ type: 'table_progress', tableName: 'users', rowsDone: 1, rowsTotal: 10, pct: 10 });
    now += 300;
    sink({ type: 'table_progress', tableName: 'users', rowsDone: 5, rowsTotal: 10, pct: 50 });

    expect(out).toHaveLength(2);
  });

  it('throttles each table independently', () => {
    const now = 1000;
    const out: MigrationEvent[] = [];
    const sink = createThrottledSink((e) => out.push(e as MigrationEvent), 250, () => now);

    sink({ type: 'table_progress', tableName: 'users', rowsDone: 1, rowsTotal: 10, pct: 10 });
    sink({ type: 'table_progress', tableName: 'orders', rowsDone: 1, rowsTotal: 10, pct: 10 });

    expect(out).toHaveLength(2);
  });

  it('never throttles lifecycle events', () => {
    const now = 1000;
    const out: MigrationEvent[] = [];
    const sink = createThrottledSink((e) => out.push(e as MigrationEvent), 250, () => now);

    sink({ type: 'step_started', stepId: 'migrate_data', ordinal: 5 });
    sink({ type: 'step_started', stepId: 'enable_triggers', ordinal: 6 });
    sink({ type: 'log', level: 'info', message: 'a' });
    sink({ type: 'log', level: 'info', message: 'b' });

    expect(out).toHaveLength(4);
  });

  it('flushes a held sample before that table finishes', () => {
    const now = 1000;
    const out: MigrationEvent[] = [];
    const sink = createThrottledSink((e) => out.push(e as MigrationEvent), 250, () => now);

    sink({ type: 'table_progress', tableName: 'users', rowsDone: 1, rowsTotal: 10, pct: 10 });
    sink({ type: 'table_progress', tableName: 'users', rowsDone: 9, rowsTotal: 10, pct: 90 });
    sink({ type: 'table_finished', tableName: 'users', rowsCopied: 10, durationMs: 5, success: true });

    // The last number a viewer sees must be the real one, not a stale sample.
    expect(out.map((e) => e.type)).toEqual(['table_progress', 'table_progress', 'table_finished']);
    expect(out[1].type === 'table_progress' && out[1].rowsDone).toBe(9);
  });

  it('flush() drains anything still held', () => {
    const now = 1000;
    const out: MigrationEvent[] = [];
    const sink = createThrottledSink((e) => out.push(e as MigrationEvent), 250, () => now);

    sink({ type: 'table_progress', tableName: 'users', rowsDone: 1, rowsTotal: 10, pct: 10 });
    sink({ type: 'table_progress', tableName: 'users', rowsDone: 7, rowsTotal: 10, pct: 70 });
    expect(out).toHaveLength(1);

    sink.flush();
    expect(out).toHaveLength(2);
  });
});

describe('createSafeSink', () => {
  it('swallows a throwing consumer so telemetry cannot abort a migration', () => {
    const onError = vi.fn();
    const sink = createSafeSink(() => {
      throw new Error('consumer exploded');
    }, onError);

    expect(() => sink({ type: 'log', level: 'info', message: 'x' })).not.toThrow();
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe('composeSink', () => {
  it('does not consume seq numbers for coalesced events', () => {
    const out: MigrationEvent[] = [];
    const sink = composeSink('run-1', (e) => out.push(e), { throttleMs: 10_000 });

    sink({ type: 'step_started', stepId: 'migrate_data', ordinal: 5 });
    // These three coalesce into nothing delivered yet...
    sink({ type: 'table_progress', tableName: 't', rowsDone: 1, rowsTotal: 9, pct: 11 });
    sink({ type: 'table_progress', tableName: 't', rowsDone: 2, rowsTotal: 9, pct: 22 });
    sink({ type: 'step_started', stepId: 'enable_triggers', ordinal: 6 });

    // ...so seq must stay gapless, or a client would think it missed events.
    expect(out.map((e) => e.seq)).toEqual([1, 2, 3]);
  });
});
