import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MigrationEvent } from '@movy/core';
import { isProcessAlive, readJournalAfter } from '../../server/runs/journal-tailer';

function journal(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'movy-journal-'));
  const path = join(dir, 'run.ndjson');
  writeFileSync(path, lines.join('\n'));
  return path;
}

function line(seq: number, type = 'log'): string {
  return JSON.stringify({ type, level: 'info', message: `m${seq}`, runId: 'r1', seq, at: new Date(seq * 1000).toISOString() });
}

describe('readJournalAfter', () => {
  it('returns only events past the cursor', async () => {
    const path = journal([line(1), line(2), line(3), line(4)]);
    const seen: MigrationEvent[] = [];

    const result = await readJournalAfter(path, 2, (e) => seen.push(e));

    expect(seen.map((e) => e.seq)).toEqual([3, 4]);
    expect(result).toEqual({ read: 2, lastSeq: 4, malformed: 0 });
  });

  it('reads nothing when the cursor is already at the end', async () => {
    const path = journal([line(1), line(2)]);
    const result = await readJournalAfter(path, 2, () => {
      throw new Error('should not be called');
    });
    expect(result.read).toBe(0);
    expect(result.lastSeq).toBe(2);
  });

  it('treats a missing journal as nothing to replay, not as an error', async () => {
    // The normal shape of a run killed between fork and first write. Throwing
    // here would abort boot recovery for every other run behind it.
    const result = await readJournalAfter('/no/such/journal.ndjson', 0, () => {});
    expect(result).toEqual({ read: 0, lastSeq: 0, malformed: 0 });
  });

  it('skips a half-written trailing line and keeps everything before it', async () => {
    // Exactly what a crash mid-write leaves behind.
    const path = journal([line(1), line(2), '{"type":"log","seq":3,"at":"2026']);
    const seen: number[] = [];

    const result = await readJournalAfter(path, 0, (e) => seen.push(e.seq));

    expect(seen).toEqual([1, 2]);
    expect(result.malformed).toBe(1);
    expect(result.lastSeq).toBe(2);
  });

  it('skips a line that parses but is not an event', async () => {
    const path = journal([line(1), JSON.stringify({ hello: 'world' }), '[]', 'null', line(2)]);
    const seen: number[] = [];

    const result = await readJournalAfter(path, 0, (e) => seen.push(e.seq));

    expect(seen).toEqual([1, 2]);
    expect(result.malformed).toBe(3);
  });

  it('ignores blank lines', async () => {
    const path = journal([line(1), '', '  ', line(2), '']);
    const result = await readJournalAfter(path, 0, () => {});
    expect(result).toEqual({ read: 2, lastSeq: 2, malformed: 0 });
  });

  it('finds a terminal event that is not the last line', async () => {
    // The fixture's real shape: ThrottledSink flushes a held progress sample
    // after run_finished. Recovery must not read the last line as the outcome.
    const finished = JSON.stringify({
      type: 'run_finished', status: 'succeeded', durationMs: 10, runId: 'r1', seq: 3, at: new Date().toISOString(),
    });
    const trailing = JSON.stringify({
      type: 'overall_progress', rowsDone: 5, rowsTotal: 5, pct: 100, tablesDone: 1, tablesTotal: 1,
      runId: 'r1', seq: 4, at: new Date().toISOString(),
    });
    const path = journal([line(1), line(2), finished, trailing]);

    const seen: MigrationEvent[] = [];
    await readJournalAfter(path, 0, (e) => seen.push(e));

    expect(seen[seen.length - 1].type).toBe('overall_progress');
    expect(seen.some((e) => e.type === 'run_finished')).toBe(true);
  });
});

describe('isProcessAlive', () => {
  it('sees this process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('reports a pid that cannot exist as gone', () => {
    expect(isProcessAlive(2 ** 30)).toBe(false);
  });

  it('treats a null or nonsensical pid as gone', () => {
    expect(isProcessAlive(null)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });
});
