import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { MigrationEvent } from '@movy/core';
import { openJournal } from '../../src/journal';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'movy-journal-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function event(seq: number): MigrationEvent {
  return {
    type: 'log',
    level: 'info',
    message: `line ${seq}`,
    runId: 'run-1',
    seq,
    at: '2026-09-07T21:29:52.000Z',
  };
}

describe('openJournal', () => {
  test('creates missing parent directories', async () => {
    const target = path.join(dir, 'nested', 'deeper', 'run.ndjson');
    const journal = openJournal(target, () => {});

    journal.write(event(1));
    await journal.close();

    expect(fs.existsSync(target)).toBe(true);
  });

  test('writes one JSON object per line, in emission order', async () => {
    const target = path.join(dir, 'run.ndjson');
    const journal = openJournal(target, () => {});

    journal.write(event(1));
    journal.write(event(2));
    journal.write(event(3));
    await journal.close();

    const lines = fs.readFileSync(target, 'utf8').trim().split('\n');
    expect(lines.map((l) => JSON.parse(l).seq)).toEqual([1, 2, 3]);
  });

  test('appends rather than truncating, so a re-exec cannot lose recorded events', async () => {
    const target = path.join(dir, 'run.ndjson');

    const first = openJournal(target, () => {});
    first.write(event(1));
    await first.close();

    const second = openJournal(target, () => {});
    second.write(event(2));
    await second.close();

    const lines = fs.readFileSync(target, 'utf8').trim().split('\n');
    expect(lines.map((l) => JSON.parse(l).seq)).toEqual([1, 2]);
  });

  test('resolves the path it reports, so the host is told where to tail', async () => {
    const journal = openJournal(path.join(dir, './run.ndjson'), () => {});
    await journal.close();

    expect(path.isAbsolute(journal.path)).toBe(true);
  });

  test('reports a write failure through the callback instead of throwing', async () => {
    const errors: Error[] = [];
    // A directory is never writable as a file: the stream errors on open.
    const journal = openJournal(path.join(dir, 'a-directory'), (err) => errors.push(err));
    fs.mkdirSync(path.join(dir, 'a-directory'), { recursive: true });

    expect(() => journal.write(event(1))).not.toThrow();
    await journal.close();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(errors).toHaveLength(1);
  });
});
