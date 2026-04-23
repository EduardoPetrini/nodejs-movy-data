import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ValidateCountsUseCase } from '../../../src/application/use-cases/validate-counts.use-case';
import { IDatabaseConnection } from '../../../src/domain/ports/database.port';
import { ILogger } from '../../../src/domain/ports/logger.port';
import { DatabaseType } from '../../../src/domain/types/connection.types';

function createMockConnection(queryFn: (sql: string, params: unknown[]) => Promise<unknown[]>): IDatabaseConnection {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockImplementation(queryFn),
    getClient: vi.fn(),
    end: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockLogger(): ILogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

const TABLE_NAMES_SQL = /information_schema\.tables/;
const COUNT_SQL = /SELECT COUNT/;

function makeQueryFn(tables: string[], counts: Record<string, number>) {
  return async (sql: string, _params: unknown[]): Promise<unknown[]> => {
    if (TABLE_NAMES_SQL.test(sql)) {
      return tables.map((t) => ({ table_name: t }));
    }
    if (COUNT_SQL.test(sql)) {
      const match = sql.match(/"([^"]+)"/) ?? sql.match(/`([^`]+)`/);
      const tableName = match ? match[1] : '';
      const count = counts[tableName] ?? 0;
      return [{ count: String(count) }];
    }
    return [];
  };
}

const PG_TARGET = { type: DatabaseType.POSTGRES, database: 'appdb' };
const MYSQL_TARGET = { type: DatabaseType.MYSQL, database: 'appdb' };

describe('ValidateCountsUseCase', () => {
  let logger: ILogger;
  let useCase: ValidateCountsUseCase;

  beforeEach(() => {
    logger = createMockLogger();
    useCase = new ValidateCountsUseCase(logger);
  });

  it('reports 100% match when all counts are equal', async () => {
    const tables = ['users', 'orders'];
    const counts = { users: 1000, orders: 5000 };

    const source = createMockConnection(makeQueryFn(tables, counts));
    const dest = createMockConnection(makeQueryFn(tables, counts));

    const result = await useCase.execute(source, dest, PG_TARGET, PG_TARGET);

    expect(result.allMatch).toBe(true);
    expect(result.totalMatchPct).toBe(100);
    expect(result.tables).toHaveLength(2);
    expect(result.tables[0]).toMatchObject({ tableName: 'users', sourceCount: 1000, destCount: 1000, matchPct: 100 });
    expect(result.tables[1]).toMatchObject({ tableName: 'orders', sourceCount: 5000, destCount: 5000, matchPct: 100 });
  });

  it('reports partial match when dest has fewer rows', async () => {
    const tables = ['events'];
    const sourceCounts = { events: 1000 };
    const destCounts = { events: 750 };

    const source = createMockConnection(makeQueryFn(tables, sourceCounts));
    const dest = createMockConnection(makeQueryFn(tables, destCounts));

    const result = await useCase.execute(source, dest, PG_TARGET, PG_TARGET);

    expect(result.allMatch).toBe(false);
    expect(result.tables[0].matchPct).toBeCloseTo(75, 1);
    expect(result.totalMatchPct).toBeCloseTo(75, 1);
  });

  it('reports 0% for a table absent in destination', async () => {
    const sourceTables = ['users'];
    const destTables: string[] = [];

    const source = createMockConnection(makeQueryFn(sourceTables, { users: 500 }));
    const dest = createMockConnection(makeQueryFn(destTables, {}));

    const result = await useCase.execute(source, dest, PG_TARGET, PG_TARGET);

    expect(result.tables[0]).toMatchObject({ tableName: 'users', destCount: 0, matchPct: 0 });
    expect(result.allMatch).toBe(false);
  });

  it('returns 100% match when source is empty', async () => {
    const source = createMockConnection(makeQueryFn([], {}));
    const dest = createMockConnection(makeQueryFn([], {}));

    const result = await useCase.execute(source, dest, PG_TARGET, PG_TARGET);

    expect(result.allMatch).toBe(true);
    expect(result.tables).toHaveLength(0);
    expect(result.totalMatchPct).toBe(100);
  });

  it('reports 100% for a table with 0 rows on both sides', async () => {
    const tables = ['empty_table'];

    const source = createMockConnection(makeQueryFn(tables, { empty_table: 0 }));
    const dest = createMockConnection(makeQueryFn(tables, { empty_table: 0 }));

    const result = await useCase.execute(source, dest, PG_TARGET, PG_TARGET);

    expect(result.tables[0]).toMatchObject({ tableName: 'empty_table', matchPct: 100 });
    expect(result.allMatch).toBe(true);
  });

  it('reports multiple tables with mixed results correctly', async () => {
    const tables = ['a', 'b', 'c'];
    const sourceCounts = { a: 100, b: 200, c: 300 };
    const destCounts   = { a: 100, b: 180, c: 300 };

    const source = createMockConnection(makeQueryFn(tables, sourceCounts));
    const dest = createMockConnection(makeQueryFn(tables, destCounts));

    const result = await useCase.execute(source, dest, PG_TARGET, PG_TARGET);

    expect(result.allMatch).toBe(false);
    expect(result.totalSource).toBe(600);
    expect(result.totalDest).toBe(580);
    const bRow = result.tables.find((t) => t.tableName === 'b');
    expect(bRow?.matchPct).toBeCloseTo(90, 1);
  });

  it('uses MySQL placeholder style and backtick quoting for MySQL targets', async () => {
    const tables = ['users'];
    const counts = { users: 42 };

    const sourceQueryFn = vi.fn(makeQueryFn(tables, counts));
    const destQueryFn = vi.fn(makeQueryFn(tables, counts));
    const source = createMockConnection(sourceQueryFn);
    const dest = createMockConnection(destQueryFn);

    await useCase.execute(source, dest, MYSQL_TARGET, MYSQL_TARGET);

    const calls = sourceQueryFn.mock.calls;
    const tablesCall = calls.find(([sql]) => TABLE_NAMES_SQL.test(sql as string));
    const countCall = calls.find(([sql]) => COUNT_SQL.test(sql as string));

    expect(tablesCall?.[0]).toContain('?');
    expect(tablesCall?.[0]).not.toContain('$1');
    expect(tablesCall?.[1]).toEqual(['appdb']);
    expect(countCall?.[0]).toContain('`users`');
  });

  it('uses PostgreSQL placeholder style and double-quote identifiers for PG targets', async () => {
    const tables = ['users'];
    const counts = { users: 7 };

    const sourceQueryFn = vi.fn(makeQueryFn(tables, counts));
    const destQueryFn = vi.fn(makeQueryFn(tables, counts));
    const source = createMockConnection(sourceQueryFn);
    const dest = createMockConnection(destQueryFn);

    await useCase.execute(source, dest, PG_TARGET, PG_TARGET);

    const calls = sourceQueryFn.mock.calls;
    const tablesCall = calls.find(([sql]) => TABLE_NAMES_SQL.test(sql as string));
    const countCall = calls.find(([sql]) => COUNT_SQL.test(sql as string));

    expect(tablesCall?.[0]).toContain('$1');
    expect(tablesCall?.[1]).toEqual(['public']);
    expect(countCall?.[0]).toContain('"users"');
  });
});
