import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkerPool } from '../../../src/infrastructure/migration/worker-pool';
import { DatabaseType, ConnectionConfig } from '../../../src/domain/types/connection.types';

vi.mock('worker_threads', () => {
  const EventEmitter = require('events');
  class MockWorker extends EventEmitter {
    constructor(_path: string, _opts: unknown) {
      super();
      setTimeout(() => {
        this.emit('message', { type: 'table_done', tableName: 'users', rowsCopied: 10, durationMs: 5 });
        this.emit('exit', 0);
      }, 0);
    }
  }
  return { Worker: MockWorker };
});

vi.mock('../../../src/shared/utils', () => ({
  resolveWorkerPath: vi.fn(() => '/fake/worker.ts'),
  chunkArray: (arr: unknown[], size: number) => {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
    return chunks;
  },
}));

function makeConfig(): ConnectionConfig {
  return { type: DatabaseType.POSTGRES, host: 'localhost', port: 5432, user: 'u', password: 'p', database: 'db' };
}

describe('WorkerPool', () => {
  let pool: WorkerPool;

  beforeEach(() => {
    pool = new WorkerPool();
    vi.clearAllMocks();
  });

  it('returns table results from worker messages', async () => {
    const results = await pool.run(makeConfig(), makeConfig(), ['users'], 1);
    expect(results).toHaveLength(1);
    expect(results[0].tableName).toBe('users');
    expect(results[0].success).toBe(true);
    expect(results[0].rowsCopied).toBe(10);
  });

  it('returns results for multiple tables across workers', async () => {
    const results = await pool.run(makeConfig(), makeConfig(), ['users', 'orders'], 2);
    // Each worker emits one table_done for 'users' (from mock)
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.success)).toBe(true);
  });
});
