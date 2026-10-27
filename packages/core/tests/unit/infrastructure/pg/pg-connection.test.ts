import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { DatabaseType } from '../../../../src/domain/types/connection.types';

/**
 * pg-pool as it behaves: `end()` resolves only once every checked-out client
 * has been released. A statement blocked on a lock never releases its client,
 * so ending alone never finishes — which is the bug `abort()` exists for.
 */
class FakePool extends EventEmitter {
  static last: FakePool;
  readonly end = vi.fn(() => this.drained);
  private releaseAll!: () => void;
  private readonly drained = new Promise<void>((r) => { this.releaseAll = r; });
  constructor() {
    super();
    FakePool.last = this;
  }
  checkOut(processID: number) {
    const client = { processID };
    this.emit('acquire', client);
    return client;
  }
  releaseClient(client: object) {
    this.emit('release', undefined, client);
    this.releaseAll();
  }
}

/** The canceller: a plain Client, on its own connection. */
const cancellers: { config: Record<string, unknown>; queries: [string, unknown[]][]; ended: boolean }[] = [];
let onCancel: (pid: number) => void = () => {};

vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(function () { return new FakePool(); }),
  Client: vi.fn().mockImplementation(function (config: Record<string, unknown>) {
    const record = { config, queries: [] as [string, unknown[]][], ended: false };
    cancellers.push(record);
    return {
      on: vi.fn(),
      connect: vi.fn(async () => {}),
      query: vi.fn(async (sql: string, params: unknown[]) => {
        record.queries.push([sql, params]);
        onCancel(params[0] as number);
        return { rows: [{ pg_cancel_backend: true }] };
      }),
      end: vi.fn(async () => { record.ended = true; }),
    };
  }),
}));

import { PgConnection } from '../../../../src/infrastructure/database/pg/pg-connection.adapter';

const config = {
  type: DatabaseType.POSTGRES, host: 'db', port: 5432, user: 'u', password: 'secret-pw', database: 'app',
};

beforeEach(() => {
  cancellers.length = 0;
  onCancel = () => {};
});

describe('PgConnection.abort', () => {
  it('cancels the statement on every busy client, which is what lets the pool end', async () => {
    const connection = new PgConnection(config);
    const pool = FakePool.last;
    const busy = pool.checkOut(4242);
    // The server answers a cancel by failing the statement; its client is released.
    onCancel = (pid) => { if (pid === 4242) pool.releaseClient(busy); };

    await connection.abort();

    expect(cancellers).toHaveLength(1);
    expect(cancellers[0]!.queries).toEqual([['SELECT pg_cancel_backend($1)', [4242]]]);
    expect(cancellers[0]!.config).toMatchObject({ host: 'db', port: 5432, user: 'u', database: 'app' });
    expect(cancellers[0]!.ended).toBe(true);
    await expect(connection.end()).resolves.toBeUndefined();
  });

  it('cancels nothing a client already gave back', async () => {
    const connection = new PgConnection(config);
    const pool = FakePool.last;
    pool.releaseClient(pool.checkOut(7));

    await connection.abort();

    expect(cancellers).toHaveLength(0);
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it('does not wait for an end the cancel could not unblock', async () => {
    // Nothing answers the cancel; abort must still return so the caller moves on.
    const connection = new PgConnection(config);
    FakePool.last.checkOut(9);

    await expect(connection.abort()).resolves.toBeUndefined();
    expect(FakePool.last.end).toHaveBeenCalledTimes(1);
  });
});

describe('PgConnection.end', () => {
  it('ends the pool once, however many callers ask — pg-pool rejects a second end', async () => {
    const connection = new PgConnection(config);
    const pool = FakePool.last;
    pool.releaseClient(pool.checkOut(1));

    await Promise.all([connection.end(), connection.end()]);

    expect(pool.end).toHaveBeenCalledTimes(1);
  });
});
