import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import type { SqlClient } from '@movy/runner/agent';
import { ensureRunnerClasses, resetRunnerClassesSync } from '../../server/runners/runner-classes';

const CLASSES_FILE = join(__dirname, '../../../../docker/runner-classes.json');

/** A meta-db that refuses the first `failures` statements, then accepts. */
function flakySql(failures: number) {
  let calls = 0;
  const sql: SqlClient = {
    query: vi.fn(async () => {
      calls += 1;
      if (calls <= failures) throw new Error('connect ECONNREFUSED');
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as SqlClient;
  return sql;
}

beforeEach(() => {
  resetRunnerClassesSync();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  resetRunnerClassesSync();
  vi.restoreAllMocks();
});

describe('ensureRunnerClasses', () => {
  it('tries again on the next call after the meta-db refused the upsert', async () => {
    const sql = flakySql(1);
    await ensureRunnerClasses(sql, CLASSES_FILE, 0);
    await ensureRunnerClasses(sql, CLASSES_FILE, 0);
    expect(sql.query).toHaveBeenCalledTimes(2);
  });

  it('retries on its own, for a console with no embedded agent to ask again', async () => {
    const sql = flakySql(1);
    await ensureRunnerClasses(sql, CLASSES_FILE, 10);
    await expect.poll(() => vi.mocked(sql.query).mock.calls.length).toBe(2);
  });

  it('remembers a success, and does not upsert twice', async () => {
    const sql = flakySql(0);
    await ensureRunnerClasses(sql, CLASSES_FILE, 0);
    await ensureRunnerClasses(sql, CLASSES_FILE, 0);
    expect(sql.query).toHaveBeenCalledTimes(1);
  });

  it('does not retry a file it cannot read, which only a deploy can fix', async () => {
    const sql = flakySql(0);
    await ensureRunnerClasses(sql, join(__dirname, 'no-such-classes.json'), 10);
    await ensureRunnerClasses(sql, join(__dirname, 'no-such-classes.json'), 10);
    expect(sql.query).not.toHaveBeenCalled();
  });
});
