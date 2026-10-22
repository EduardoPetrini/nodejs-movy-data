import { describe, it, expect, vi } from 'vitest';
import { toRowCount } from '../../../src/shared/utils';
import { PgSchemaInspector } from '../../../src/infrastructure/database/pg/pg-schema-inspector.adapter';
import { IDatabaseConnection } from '../../../src/domain/ports/database.port';

describe('toRowCount', () => {
  it('parses the strings drivers return for 64-bit integer columns', () => {
    // node-pg returns reltuples::bigint as a string to avoid precision loss.
    expect(toRowCount('20000')).toBe(20000);
    expect(toRowCount('0')).toBe(0);
  });

  it('passes numbers and bigints through', () => {
    expect(toRowCount(42)).toBe(42);
    expect(toRowCount(42n)).toBe(42);
  });

  it('degrades to 0 rather than poisoning arithmetic with NaN', () => {
    expect(toRowCount(null)).toBe(0);
    expect(toRowCount(undefined)).toBe(0);
    expect(toRowCount('not a number')).toBe(0);
    expect(toRowCount(Infinity)).toBe(0);
  });
});

describe('getTableRowEstimates value types', () => {
  function connectionReturning(rows: unknown[]): IDatabaseConnection {
    return {
      connect: vi.fn(),
      query: vi.fn().mockResolvedValue(rows),
      getClient: vi.fn(),
      end: vi.fn(),
    } as never;
  }

  it('returns real numbers even when the driver hands back strings', async () => {
    // Regression: the map is typed Map<string, number> but query<T> is an
    // unchecked cast, so strings used to flow straight through. Summing them
    // concatenated ("0" + "20000" = "020000"), which collapsed every
    // overall-progress percentage to 0.
    const conn = connectionReturning([
      { relname: 'customers', reltuples: '20000' },
      { relname: 'orders', reltuples: '60000' },
    ]);

    const estimates = await new PgSchemaInspector().getTableRowEstimates(conn);

    expect([...estimates.values()].every((v) => typeof v === 'number')).toBe(true);
    expect([...estimates.values()].reduce((sum, v) => sum + v, 0)).toBe(80000);
  });

  it('still falls back to an exact count when the estimate is -1 or 0', async () => {
    const conn = connectionReturning([{ relname: 'fresh', reltuples: '-1' }]);
    (conn.query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ relname: 'fresh', reltuples: '-1' }])
      .mockResolvedValueOnce([{ count: '1234' }]);

    const estimates = await new PgSchemaInspector().getTableRowEstimates(conn);
    expect(estimates.get('fresh')).toBe(1234);
  });
});
