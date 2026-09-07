import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CreateDatabaseUseCase } from '../../../src/application/use-cases/create-database.use-case';
import { createMockConnection } from '../../helpers/mock-database';
import { ILogger } from '../../../src/domain/ports/logger.port';
import { DatabaseAdapterSet } from '../../../src/infrastructure/database/registry';
import { IDatabaseConnection } from '../../../src/domain/ports/database.port';

function makeLogger(): ILogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeAdapterSet(ensureDb: (conn: IDatabaseConnection, name: string) => Promise<boolean>): DatabaseAdapterSet {
  return {
    adminDatabase: 'postgres',
    createConnection: vi.fn(),
    createSchemaInspector: vi.fn(),
    createSchemaSynchronizer: vi.fn(),
    createDataMigrator: vi.fn(),
    ensureDatabase: vi.fn().mockImplementation(ensureDb),
  };
}

describe('CreateDatabaseUseCase', () => {
  let logger: ILogger;

  beforeEach(() => {
    logger = makeLogger();
  });

  it('creates the database when it does not exist', async () => {
    const adapters = makeAdapterSet(async () => true);
    const useCase = new CreateDatabaseUseCase(adapters, logger);
    const conn = createMockConnection();

    const created = await useCase.execute(conn, 'mydb');

    expect(created).toBe(true);
    expect(adapters.ensureDatabase).toHaveBeenCalledWith(conn, 'mydb');
  });

  it('skips creation when database already exists', async () => {
    const adapters = makeAdapterSet(async () => false);
    const useCase = new CreateDatabaseUseCase(adapters, logger);
    const conn = createMockConnection();

    const created = await useCase.execute(conn, 'mydb');

    expect(created).toBe(false);
  });

  it('logs info when database is created', async () => {
    const adapters = makeAdapterSet(async () => true);
    const useCase = new CreateDatabaseUseCase(adapters, logger);
    const conn = createMockConnection();

    await useCase.execute(conn, 'newdb');

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('created'));
  });

  it('logs info when database already exists', async () => {
    const adapters = makeAdapterSet(async () => false);
    const useCase = new CreateDatabaseUseCase(adapters, logger);
    const conn = createMockConnection();

    await useCase.execute(conn, 'mydb');

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('already exists'));
  });
});
