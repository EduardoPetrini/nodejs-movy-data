import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CreateDatabaseUseCase } from '../../../src/application/use-cases/create-database.use-case';
import { createMockConnection } from '../../helpers/mock-database';
import { ILogger } from '../../../src/domain/ports/logger.port';

function makeLogger(): ILogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

describe('CreateDatabaseUseCase', () => {
  let useCase: CreateDatabaseUseCase;
  let logger: ILogger;

  beforeEach(() => {
    logger = makeLogger();
    useCase = new CreateDatabaseUseCase(logger);
  });

  it('creates the database when it does not exist', async () => {
    const conn = createMockConnection();
    (conn.query as any)
      .mockResolvedValueOnce([]) // pg_database check returns nothing
      .mockResolvedValueOnce([]); // CREATE DATABASE

    const created = await useCase.execute(conn, 'mydb');

    expect(created).toBe(true);
    expect(conn.query).toHaveBeenCalledTimes(2);
    expect((conn.query as any).mock.calls[1][0]).toMatch(/CREATE DATABASE/);
  });

  it('skips creation when database already exists', async () => {
    const conn = createMockConnection();
    (conn.query as any).mockResolvedValueOnce([{ datname: 'mydb' }]);

    const created = await useCase.execute(conn, 'mydb');

    expect(created).toBe(false);
    expect(conn.query).toHaveBeenCalledTimes(1);
  });

  it('logs info on skip', async () => {
    const conn = createMockConnection();
    (conn.query as any).mockResolvedValueOnce([{ datname: 'mydb' }]);
    await useCase.execute(conn, 'mydb');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('already exists'));
  });

  it('logs info on creation', async () => {
    const conn = createMockConnection();
    (conn.query as any).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await useCase.execute(conn, 'newdb');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('created'));
  });
});
