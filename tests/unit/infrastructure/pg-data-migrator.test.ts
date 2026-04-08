import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PgDataMigrator } from '../../../src/infrastructure/migration/pg-data-migrator.adapter';
import { WorkerPool } from '../../../src/infrastructure/migration/worker-pool';
import { DatabaseType, ConnectionConfig } from '../../../src/domain/types/connection.types';
import { TableMigrationResult } from '../../../src/domain/types/migration.types';

function makeConfig(db = 'src'): ConnectionConfig {
  return { type: DatabaseType.POSTGRES, host: 'localhost', port: 5432, user: 'u', password: 'p', database: db };
}

function makeTableResult(tableName: string, success = true): TableMigrationResult {
  return { tableName, rowsCopied: 10, durationMs: 5, success };
}

describe('PgDataMigrator', () => {
  let pool: WorkerPool;
  let migrator: PgDataMigrator;

  beforeEach(() => {
    pool = { run: vi.fn().mockResolvedValue([makeTableResult('users')]) } as unknown as WorkerPool;
    migrator = new PgDataMigrator(pool);
  });

  it('delegates to WorkerPool.run', async () => {
    await migrator.migrate(makeConfig(), makeConfig('dst'), ['users'], 2);
    expect(pool.run).toHaveBeenCalledWith(makeConfig(), makeConfig('dst'), ['users'], 2);
  });

  it('returns success=true when all tables succeed', async () => {
    const result = await migrator.migrate(makeConfig(), makeConfig('dst'), ['users'], 1);
    expect(result.success).toBe(true);
  });

  it('returns success=false when any table fails', async () => {
    (pool.run as any).mockResolvedValue([
      makeTableResult('users', true),
      makeTableResult('orders', false),
    ]);
    const result = await migrator.migrate(makeConfig(), makeConfig('dst'), ['users', 'orders'], 1);
    expect(result.success).toBe(false);
  });

  it('includes totalDurationMs in result', async () => {
    const result = await migrator.migrate(makeConfig(), makeConfig('dst'), ['users'], 1);
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
  });
});
