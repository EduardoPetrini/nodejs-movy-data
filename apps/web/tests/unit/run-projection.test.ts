import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MigrationEvent } from '@movy/core';
import { projectEvents } from '../../server/runs/run-projection';

const FIXTURE = join(__dirname, '../../../runner/fixtures/pg-to-pg-315k.ndjson');

function fixtureEvents(): MigrationEvent[] {
  return readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as MigrationEvent);
}

let seq = 0;
function event<T extends MigrationEvent['type']>(
  type: T,
  rest: Partial<MigrationEvent> = {}
): MigrationEvent {
  seq += 1;
  return { type, runId: 'r1', seq, at: new Date(seq * 1000).toISOString(), ...rest } as MigrationEvent;
}

describe('projectEvents — against the recorded run', () => {
  const events = fixtureEvents();
  const projection = projectEvents(events);

  it('reads the fixture at all (guards against a moved path)', () => {
    expect(events.length).toBe(118);
  });

  it('emits one event row per event, carrying seq and type', () => {
    expect(projection.events).toHaveLength(events.length);
    expect(projection.events[0].type).toBe('run_started');
    expect(projection.events[0].seq).toBe(1);
  });

  it('lifts level out for log events only', () => {
    const logs = projection.events.filter((e) => e.type === 'log');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((e) => e.level !== null)).toBe(true);
    expect(projection.events.filter((e) => e.type !== 'log').every((e) => e.level === null)).toBe(true);
  });

  it('takes the terminal status from run_finished, not from the last line', () => {
    // The fixture's run_finished is at seq 117 of 118: ThrottledSink flushes a
    // held progress sample on close, so a trailing overall_progress follows it.
    const last = events[events.length - 1];
    expect(last.type).toBe('overall_progress');
    expect(projection.run.status).toBe('succeeded');
  });

  it('advances lastSeq to the highest seq seen, not to the last event', () => {
    expect(projection.run.lastSeq).toBe(Math.max(...events.map((e) => e.seq)));
  });

  it('seeds every planned table from plan_ready, then finishes them all', () => {
    expect(projection.run.tablesTotal).toBe(5);
    expect(projection.tables).toHaveLength(5);
    expect(projection.tables.every((t) => t.status === 'done')).toBe(true);
  });

  it('projects all nine timeline steps as ok', () => {
    expect(projection.steps).toHaveLength(9);
    expect(projection.steps.every((s) => s.status === 'ok')).toBe(true);
    expect(projection.steps.map((s) => s.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe('projectEvents — ordering rules', () => {
  it('does not un-finish a table when a flushed progress sample arrives late', () => {
    // Exactly what ThrottledSink's close-flush produces, and the reason the
    // guard exists: without it the table flips back to running and stays there.
    const projection = projectEvents([
      event('table_finished', { tableName: 'orders', rowsCopied: 100, durationMs: 5, success: true }),
      event('table_progress', { tableName: 'orders', rowsDone: 90, rowsTotal: 100, pct: 90 }),
    ]);

    expect(projection.tables).toHaveLength(1);
    expect(projection.tables[0].status).toBe('done');
    expect(projection.tables[0].pct).toBe(100);
  });

  it('keeps a failed table failed', () => {
    const projection = projectEvents([
      event('table_finished', { tableName: 'items', rowsCopied: 3, durationMs: 1, success: false, error: 'boom' }),
      event('table_progress', { tableName: 'items', rowsDone: 3, rowsTotal: 10, pct: 30 }),
    ]);
    expect(projection.tables[0].status).toBe('failed');
    expect(projection.tables[0].error).toBe('boom');
  });

  it('carries a run failure error onto the run patch', () => {
    const projection = projectEvents([
      event('run_finished', {
        status: 'failed',
        durationMs: 12,
        error: { name: 'MigrationError', message: 'relation does not exist' },
      }),
    ]);
    expect(projection.run.status).toBe('failed');
    expect(projection.run.errorName).toBe('MigrationError');
    expect(projection.run.errorMessage).toBe('relation does not exist');
  });

  it('clears the error fields on a successful finish rather than leaving them unset', () => {
    // Explicit null, not undefined: the patch is spread into an UPDATE, and an
    // absent key would leave a stale error from an earlier attempt in place.
    const projection = projectEvents([event('run_finished', { status: 'succeeded', durationMs: 9 })]);
    expect(projection.run.errorName).toBeNull();
    expect(projection.run.errorMessage).toBeNull();
  });

  it('never lowers lastSeq when a batch arrives out of order', () => {
    const projection = projectEvents([
      event('log', { level: 'info', message: 'b' }),
      { ...event('log', { level: 'info', message: 'a' }), seq: 1 } as MigrationEvent,
    ]);
    expect(projection.run.lastSeq).toBeGreaterThan(1);
  });

  it('produces an empty projection for an empty batch', () => {
    const projection = projectEvents([]);
    expect(projection.events).toEqual([]);
    expect(projection.steps).toEqual([]);
    expect(projection.tables).toEqual([]);
    expect(projection.run.lastSeq).toBeUndefined();
  });
});
