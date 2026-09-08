import * as path from 'path';
import { describe, expect, test } from 'vitest';
import { MIGRATION_STEP_ORDER } from '@movy/core';
import type { MigrationEvent } from '@movy/core';
import { readJournalLines, replayJournal } from '../../src/simulate';

const FIXTURE = path.resolve(__dirname, '../../fixtures/pg-to-pg-315k.ndjson');

/**
 * Replays the committed recording end to end. This is both a test of the
 * simulator and the guard on the fixture itself: everything downstream in
 * Phase 3 — projections, the reducer, the socket fan-out — is built against
 * this file, so a silent edit to it must fail here rather than in the UI.
 */
async function replayFixture(): Promise<MigrationEvent[]> {
  const events: MigrationEvent[] = [];
  const status = await replayJournal(readJournalLines(FIXTURE), {
    runId: 'replayed-run',
    speed: 1,
    emit: (event) => events.push(event),
    signal: new AbortController().signal,
    // No waiting: timing is covered by simulate.test.ts.
    sleep: () => Promise.resolve(),
  });
  expect(status).toBe('succeeded');
  return events;
}

describe('pg-to-pg-315k fixture', () => {
  test('replays 118 events with a gapless seq', async () => {
    const events = await replayFixture();

    expect(events).toHaveLength(118);
    expect(events.map((e) => e.seq)).toEqual(
      Array.from({ length: 118 }, (_, i) => i + 1)
    );
  });

  test('every event is restamped onto the new run', async () => {
    const events = await replayFixture();

    expect(events.every((e) => e.runId === 'replayed-run')).toBe(true);
  });

  test('reports all nine steps, each ok', async () => {
    const events = await replayFixture();
    const finished = events.filter((e) => e.type === 'step_finished');

    expect(finished.map((e) => e.stepId)).toEqual([...MIGRATION_STEP_ORDER]);
    expect(finished.every((e) => e.status === 'ok')).toBe(true);
  });

  test('overall progress climbs monotonically to 100', async () => {
    const events = await replayFixture();
    const pcts = events.filter((e) => e.type === 'overall_progress').map((e) => e.pct);

    expect(pcts.length).toBeGreaterThan(1);
    expect([...pcts].sort((a, b) => a - b)).toEqual(pcts);
    expect(pcts.at(-1)).toBe(100);
  });

  // The recording's terminal event is NOT its last line: the producer's throttle
  // flushes a held progress sample on close. Anything reading this stream must
  // key off the event, not the position.
  test('the terminal event is followed by a flushed progress sample', async () => {
    const events = await replayFixture();

    expect(events.at(-2)).toMatchObject({ type: 'run_finished', status: 'succeeded' });
    expect(events.at(-1)!.type).toBe('overall_progress');
  });

  // Matched as JSON keys rather than as substrings: a table legitimately named
  // "users" must not trip this, and a leaked `"user":` field must.
  test('carries no connection details, only engine and database', async () => {
    const raw = (await replayFixture()).map((e) => JSON.stringify(e)).join('\n');

    for (const key of ['host', 'port', 'user', 'username', 'password', 'ssl']) {
      expect(raw).not.toContain(`"${key}":`);
    }
  });
});
