import { vi } from 'vitest';
import { IDatabaseConnection } from '../../src/domain/ports/database.port';
import { PoolClient } from 'pg';

export function createMockConnection(overrides?: Partial<IDatabaseConnection>): IDatabaseConnection {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([]),
    getClient: vi.fn().mockResolvedValue({
      query: vi.fn(),
      release: vi.fn(),
    } as unknown as PoolClient),
    end: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

export function mockQueryResults<T>(
  connection: IDatabaseConnection,
  results: T[]
): void {
  (connection.query as ReturnType<typeof vi.fn>).mockResolvedValue(results);
}

export function mockQuerySequence<T>(
  connection: IDatabaseConnection,
  sequence: T[][]
): void {
  const mock = connection.query as ReturnType<typeof vi.fn>;
  sequence.forEach((result) => {
    mock.mockResolvedValueOnce(result);
  });
}
