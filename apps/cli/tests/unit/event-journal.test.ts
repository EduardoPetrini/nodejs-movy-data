import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseJsonEventsFlag, createEventJournal } from '../../src/presentation/cli/event-journal';
import type { MigrationEvent } from '@movy/core';

const created: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'movy-journal-'));
  created.push(dir);
  return dir;
}
afterEach(() => {
  while (created.length) fs.rmSync(created.pop()!, { recursive: true, force: true });
});

describe('parseJsonEventsFlag', () => {
  const LOG = '/var/log/movy/movy_2026-01-01_00-00-00_a_to_b.log';

  it('returns null when the flag is absent', () => {
    expect(parseJsonEventsFlag(['--other'], LOG)).toBeNull();
  });

  it('defaults to a path beside the log file', () => {
    expect(parseJsonEventsFlag(['--json-events'], LOG)).toBe(
      '/var/log/movy/movy_2026-01-01_00-00-00_a_to_b.events.ndjson'
    );
  });

  it('honours an explicit --json-events=<path>', () => {
    expect(parseJsonEventsFlag(['--json-events=/tmp/run.ndjson'], LOG)).toBe('/tmp/run.ndjson');
  });

  it('falls back to the default when given an empty value', () => {
    expect(parseJsonEventsFlag(['--json-events='], LOG)).toContain('.events.ndjson');
  });
});

describe('createEventJournal', () => {
  function readEvents(file: string): MigrationEvent[] {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as MigrationEvent);
  }

  it('writes one JSON event per line, sequenced', async () => {
    const file = path.join(tmpDir(), 'run.ndjson');
    const journal = createEventJournal(file, 'run-42');

    journal.context.emit({ type: 'step_started', stepId: 'sync_schema', ordinal: 3 });
    journal.context.emit({ type: 'log', level: 'info', message: 'hello' });
    await journal.close();

    const events = readEvents(file);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(events.every((e) => e.runId === 'run-42')).toBe(true);
    expect(events[0].type).toBe('step_started');
  });

  it('creates the parent directory if it does not exist', async () => {
    const file = path.join(tmpDir(), 'nested', 'deeper', 'run.ndjson');
    const journal = createEventJournal(file, 'run-1');
    journal.context.emit({ type: 'log', level: 'info', message: 'x' });
    await journal.close();

    expect(fs.existsSync(file)).toBe(true);
  });

  it('flushes a throttled progress sample on close', async () => {
    const file = path.join(tmpDir(), 'run.ndjson');
    const journal = createEventJournal(file, 'run-1');

    // Two samples inside one throttle window: the second is held back, and
    // must still reach the journal rather than being lost at shutdown.
    journal.context.emit({ type: 'table_progress', tableName: 't', rowsDone: 1, rowsTotal: 10, pct: 10 });
    journal.context.emit({ type: 'table_progress', tableName: 't', rowsDone: 9, rowsTotal: 10, pct: 90 });
    await journal.close();

    const events = readEvents(file);
    expect(events).toHaveLength(2);
    expect(events[1].type === 'table_progress' && events[1].rowsDone).toBe(9);
  });

  it('produces a stream that is valid NDJSON end to end', async () => {
    const file = path.join(tmpDir(), 'run.ndjson');
    const journal = createEventJournal(file, 'run-1');

    journal.context.emit({
      type: 'run_started',
      mode: 'full',
      source: { engine: 'postgres' as never, database: 'src' },
      target: { engine: 'postgres' as never, database: 'dst' },
    });
    journal.context.emit({ type: 'run_finished', status: 'succeeded', durationMs: 12 });
    await journal.close();

    const raw = fs.readFileSync(file, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(() => raw.split('\n').filter(Boolean).forEach((l) => JSON.parse(l))).not.toThrow();
  });
});
