import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PgDataMigrator } from '../../../src/infrastructure/migration/pg-data-migrator.adapter';
import { WorkerPool } from '../../../src/infrastructure/migration/worker-pool';
import { DatabaseType, ConnectionConfig } from '../../../src/domain/types/connection.types';
import { TableMigrationPlan, TableMigrationResult } from '../../../src/domain/types/migration.types';

function makeConfig(db = 'src'): ConnectionConfig {
  return { type: DatabaseType.POSTGRES, host: 'localhost', port: 5432, user: 'u', password: 'p', database: db };
}

function makeTableResult(tableName: string, success = true): TableMigrationResult {
  return { tableName, rowsCopied: 10, durationMs: 5, success };
}

function makePlan(): TableMigrationPlan {
  return {
    loadOrder: ['users'],
    cleanupOrder: ['users'],
    levels: [['users']],
    cyclicTables: [],
  };
}

describe('PgDataMigrator', () => {
  let pool: WorkerPool;
  let migrator: PgDataMigrator;
  let destQuery: ReturnType<typeof vi.fn>;
  let destEnd: ReturnType<typeof vi.fn>;

  function stubDestConnection() {
    destQuery = vi.fn().mockResolvedValue([]);
    destEnd = vi.fn().mockResolvedValue(undefined);
    return () =>
      ({
        connect: vi.fn().mockResolvedValue(undefined),
        query: destQuery,
        getClient: vi.fn(),
        end: destEnd,
      }) as never;
  }

  beforeEach(() => {
    pool = { run: vi.fn().mockResolvedValue([makeTableResult('users')]) } as unknown as WorkerPool;
    migrator = new PgDataMigrator(pool, stubDestConnection());
  });

  it('delegates to WorkerPool.run', async () => {
    await migrator.migrate(makeConfig(), makeConfig('dst'), makePlan(), 2);
    expect(pool.run).toHaveBeenCalledWith(
      makeConfig(),
      makeConfig('dst'),
      ['users'],
      2,
      undefined,
      undefined,
      // The cancellation signal, absent here: migrate() was called without one.
      undefined
    );
  });

  it('returns success=true when all tables succeed', async () => {
    const result = await migrator.migrate(makeConfig(), makeConfig('dst'), makePlan(), 1);
    expect(result.success).toBe(true);
  });

  it('returns success=false when any table fails', async () => {
    (pool.run as any).mockResolvedValue([
      makeTableResult('users', true),
      makeTableResult('orders', false),
    ]);
    const result = await migrator.migrate(
      makeConfig(),
      makeConfig('dst'),
      { loadOrder: ['users', 'orders'], cleanupOrder: ['orders', 'users'], levels: [['users'], ['orders']], cyclicTables: [] },
      1
    );
    expect(result.success).toBe(false);
  });

  it('includes totalDurationMs in result', async () => {
    const result = await migrator.migrate(makeConfig(), makeConfig('dst'), makePlan(), 1);
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  describe('destination clearing', () => {
    // Regression: the worker used to run "TRUNCATE <table> RESTRICT" per table.
    // PostgreSQL refuses that for any table another table references — a
    // structural check that DISABLE TRIGGER does not lift — so every FK-parent
    // failed on a re-run into a populated destination.
    it('clears the whole load set in a single statement before copying', async () => {
      await migrator.migrate(
        makeConfig(),
        makeConfig('dst'),
        { loadOrder: ['customers', 'orders'], cleanupOrder: ['orders', 'customers'], levels: [['customers'], ['orders']], cyclicTables: [] },
        2
      );

      const statements = destQuery.mock.calls.map(([sql]) => sql as string);
      expect(statements).toHaveLength(1);
      expect(statements[0]).toBe('TRUNCATE "customers", "orders"');
    });

    it('clears before the workers start, never in parallel with them', async () => {
      const order: string[] = [];
      destQuery.mockImplementation(async () => { order.push('clear'); return []; });
      (pool.run as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('copy'); return []; });

      await migrator.migrate(makeConfig(), makeConfig('dst'), makePlan(), 1);

      expect(order).toEqual(['clear', 'copy']);
    });

    it('closes the destination connection even when clearing fails', async () => {
      destQuery.mockRejectedValue(new Error('permission denied'));
      await expect(
        migrator.migrate(makeConfig(), makeConfig('dst'), makePlan(), 1)
      ).rejects.toThrow();
      expect(destEnd).toHaveBeenCalled();
    });

    it('does nothing when the plan is empty', async () => {
      await migrator.migrate(
        makeConfig(),
        makeConfig('dst'),
        { loadOrder: [], cleanupOrder: [], levels: [], cyclicTables: [] },
        1
      );
      expect(destQuery).not.toHaveBeenCalled();
    });
  });
});