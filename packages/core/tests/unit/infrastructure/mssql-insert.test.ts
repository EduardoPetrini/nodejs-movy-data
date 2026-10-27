import { describe, it, expect, vi } from 'vitest';
import {
  MSSQL_MAX_PARAMS,
  insertMssqlRows,
  mssqlRowsPerInsert,
} from '../../../src/infrastructure/migration/mssql-insert';
import { IDbClient } from '../../../src/domain/ports/database.port';

function recordingClient() {
  const calls: { sql: string; params: unknown[] }[] = [];
  const client: IDbClient = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      return [];
    }) as IDbClient['query'],
    release: vi.fn(),
  };
  return { client, calls };
}

function rows(n: number, columns: string[]): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => Object.fromEntries(columns.map((c) => [c, `${c}${i}`])));
}

describe('mssqlRowsPerInsert', () => {
  it('stays under SQL Server\'s parameter cap for any column count', () => {
    for (const cols of [1, 4, 5, 7, 50, 333, 2000]) {
      expect(mssqlRowsPerInsert(cols) * cols).toBeLessThan(MSSQL_MAX_PARAMS);
    }
  });

  it('never exceeds the 1000-row limit of a VALUES list', () => {
    expect(mssqlRowsPerInsert(1)).toBeLessThanOrEqual(1000);
  });

  it('always inserts at least one row, however wide the table', () => {
    expect(mssqlRowsPerInsert(5000)).toBe(1);
  });
});

describe('insertMssqlRows', () => {
  const columns = ['id', 'a', 'b', 'c', 'd', 'e', 'f'];

  it('splits a 500-row batch of a 7-column table into statements under the cap', async () => {
    // 500 x 7 = 3500 parameters in one statement is what SQL Server refused.
    const { client, calls } = recordingClient();
    await insertMssqlRows(client, '[orders]', columns, rows(500, columns));
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) expect(call.params.length).toBeLessThan(MSSQL_MAX_PARAMS);
  });

  it('inserts every row exactly once and in order', async () => {
    const { client, calls } = recordingClient();
    await insertMssqlRows(client, '[orders]', columns, rows(500, columns));
    const ids = calls.flatMap((c) => c.params.filter((_, i) => i % columns.length === 0));
    expect(ids).toEqual(rows(500, columns).map((r) => r.id));
  });

  it('writes one placeholder group per row and names the columns', async () => {
    const { client, calls } = recordingClient();
    await insertMssqlRows(client, '[t]', ['x', 'y'], rows(2, ['x', 'y']));
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toBe('INSERT INTO [t] ([x], [y]) VALUES (?, ?), (?, ?)');
    expect(calls[0].params).toEqual(['x0', 'y0', 'x1', 'y1']);
  });

  it('sends a missing value as NULL', async () => {
    const { client, calls } = recordingClient();
    await insertMssqlRows(client, '[t]', ['x', 'y'], [{ x: 1 }]);
    expect(calls[0].params).toEqual([1, null]);
  });

  it('issues nothing for an empty batch', async () => {
    const { client, calls } = recordingClient();
    await insertMssqlRows(client, '[t]', ['x'], []);
    expect(calls).toHaveLength(0);
  });
});
