import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MigrateDataUseCase } from '../../../src/application/use-cases/migrate-data.use-case';
import { IDataMigrator } from '../../../src/domain/ports/data-migrator.port';
import { ILogger } from '../../../src/domain/ports/logger.port';
import { DatabaseType, ConnectionConfig } from '../../../src/domain/types/connection.types';
import { MigrationResult } from '../../../src/domain/types/migration.types';

function makeLogger(): ILogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeConfig(db = 'testdb'): ConnectionConfig {
  return { type: DatabaseType.POSTGRES, host: 'localhost', port: 5432, user: 'u', password: 'p', database: db };
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

  it('calls migrator.migrate with sorted tables and worker count', async () => {
    const estimates = new Map([['users', 1000], ['orders', 5000]]);
    await useCase.execute(makeConfig(), makeConfig('dest'), ['users', 'orders'], estimates);

    const call = (migrator.migrate as any).mock.calls[0];
    // orders has more rows, should be first
    expect(call[2][0]).toBe('orders');
    expect(call[2][1]).toBe('users');
  });

  it('caps workers at 4', async () => {
    const tables = ['a', 'b', 'c', 'd', 'e', 'f'];
    await useCase.execute(makeConfig(), makeConfig('dest'), tables, new Map());
    const workerCount = (migrator.migrate as any).mock.calls[0][3];
    expect(workerCount).toBeLessThanOrEqual(4);
  });

  it('returns migration result', async () => {
    const result = await useCase.execute(makeConfig(), makeConfig('dest'), ['users'], new Map());
    expect(result.success).toBe(true);
  });

  it('logs the report', async () => {
    await useCase.execute(makeConfig(), makeConfig('dest'), ['users'], new Map());
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Migration Report'));
  });
});
