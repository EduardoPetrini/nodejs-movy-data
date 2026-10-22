import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MigrateDataUseCase } from '../../../src/application/use-cases/migrate-data.use-case';
import { IDataMigrator } from '../../../src/domain/ports/data-migrator.port';
import { ILogger } from '../../../src/domain/ports/logger.port';
import { DatabaseType, ConnectionConfig } from '../../../src/domain/types/connection.types';
import { MigrationResult } from '../../../src/domain/types/migration.types';
import { TableSchema } from '../../../src/domain/types/schema.types';

function makeLogger(): ILogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeConfig(db = 'testdb'): ConnectionConfig {
  return { type: DatabaseType.POSTGRES, host: 'localhost', port: 5432, user: 'u', password: 'p', database: db };
}

function makeTable(
  name: string,
  referencedTable?: string
): TableSchema {
  return {
    name,
    columns: [],
    indexes: [],
    constraints: referencedTable
      ? [{
          name: `fk_${name}_${referencedTable}`,
          type: 'FOREIGN KEY',
          columns: ['parent_id'],
          referencedTable,
          referencedColumns: ['id'],
        }]
      : [],
  };
}

function makeResult(success = true): MigrationResult {
  return {
    tables: [{ tableName: 'users', rowsCopied: 100, durationMs: 50, success }],
    totalDurationMs: 100,
    success,
  };
}

describe('MigrateDataUseCase', () => {
  let migrator: IDataMigrator;
  let logger: ILogger;
  let useCase: MigrateDataUseCase;

  beforeEach(() => {
    migrator = { migrate: vi.fn().mockResolvedValue(makeResult()) };
    logger = makeLogger();
    useCase = new MigrateDataUseCase(migrator, logger);
  });

  it('calls migrator.migrate with dependency-aware ordering', async () => {
    const estimates = new Map([['users', 1000], ['orders', 5000]]);
    await useCase.execute(
      makeConfig(),
      makeConfig('dest'),
      [makeTable('orders', 'users'), makeTable('users')],
      estimates
    );

    const call = (migrator.migrate as any).mock.calls[0];
    expect(call[2]).toEqual({
      loadOrder: ['users', 'orders'],
      cleanupOrder: ['orders', 'users'],
      levels: [['users'], ['orders']],
      cyclicTables: [],
    });
  });

  it('caps workers at 4 for postgres-to-postgres migrations', async () => {
    const tables = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => makeTable(name));
    await useCase.execute(makeConfig(), makeConfig('dest'), tables, new Map());
    const workerCount = (migrator.migrate as any).mock.calls[0][3];
    expect(workerCount).toBeLessThanOrEqual(4);
  });

  it('uses a single worker for mysql migrations', async () => {
    const mysqlConfig = { ...makeConfig(), type: DatabaseType.MYSQL };
    await useCase.execute(mysqlConfig, mysqlConfig, [makeTable('users')], new Map());
    const workerCount = (migrator.migrate as any).mock.calls[0][3];
    expect(workerCount).toBe(1);
  });

  it('returns migration result', async () => {
    const result = await useCase.execute(makeConfig(), makeConfig('dest'), [makeTable('users')], new Map());
    expect(result.success).toBe(true);
  });

  it('logs the summary table', async () => {
    await useCase.execute(makeConfig(), makeConfig('dest'), [makeTable('users')], new Map());
    const calls: string[] = (logger.info as any).mock.calls.map((c: string[]) => c[0]);
    // The summary contains a header row and a totals row
    expect(calls.some((c) => c.includes('Table'))).toBe(true);
    expect(calls.some((c) => c.includes('TOTAL'))).toBe(true);
  });
});
