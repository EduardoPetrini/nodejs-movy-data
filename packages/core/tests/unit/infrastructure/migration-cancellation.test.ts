import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MysqlDataMigrator } from '../../../src/infrastructure/migration/mysql-data-migrator.adapter';
import { PgDataMigrator } from '../../../src/infrastructure/migration/pg-data-migrator.adapter';
import { WorkerPool } from '../../../src/infrastructure/migration/worker-pool';
import { throwIfCancelled } from '../../../src/infrastructure/migration/cancellation';
import { MigrationCancelledError } from '../../../src/domain/errors/migration.errors';
import { DatabaseType, ConnectionConfig } from '../../../src/domain/types/connection.types';
import { TableMigrationPlan } from '../../../src/domain/types/migration.types';

/**
 * Cancellation used to be observed at exactly one point — before a step — so
 * pressing Cancel on a PG→PG run marked it cancelled while four worker threads
 * kept writing to the destination. These tests assert the two things that
 * actually stop work: the per-table check in the sequential migrators, and
 * WorkerPool.terminate() for the parallel one.
 *
 * What none of them assert is a rollback, because there isn't one. A cancelled
 * run leaves the destination partly written, which is why the check placement
 * matters so much: it decides how much.
 */

const connectionQueue: any[] = [];

vi.mock('../../../src/infrastructure/database/mysql/mysql-connection.adapter', () => ({
  MysqlConnection: class {
    constructor() {
      const instance = connectionQueue.shift();
      if (!instance) throw new Error('Missing MysqlConnection mock');
      return instance;
    }
  },
}));

function makeConfig(database: string, type = DatabaseType.MYSQL): ConnectionConfig {
  return { type, host: 'localhost', port: 3306, user: 'u', password: 'p', database };
}

function makePlan(): TableMigrationPlan {
  return {
    cleanupOrder: ['child', 'parent'],
    loadOrder: ['parent', 'child'],
    levels: [['parent'], ['child']],
    cyclicTables: [],
  };
}

describe('throwIfCancelled', () => {
  it('does nothing without a signal, or with one that has not aborted', () => {
    expect(() => throwIfCancelled(undefined, 'x')).not.toThrow();
    expect(() => throwIfCancelled(new AbortController().signal, 'x')).not.toThrow();
  });

  it('names where it stopped, because nothing is rolled back', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfCancelled(controller.signal, 'before copying "orders"')).toThrow(
      MigrationCancelledError
    );
    expect(() => throwIfCancelled(controller.signal, 'before copying "orders"')).toThrow(
      /before copying "orders"/
    );
  });
});

describe('sequential migrator cancellation', () => {
  let source: any;
  let dest: any;
  let destClient: any;
  let migrator: MysqlDataMigrator;

  beforeEach(() => {
    connectionQueue.length = 0;
    destClient = { query: vi.fn().mockResolvedValue([]), release: vi.fn() };
    source = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn((sql: string) => {
        if (sql.includes('SHOW COLUMNS')) return Promise.resolve([{ Field: 'id' }]);
        if (sql.includes('SELECT `id` FROM')) return Promise.resolve([{ id: 1 }]);
        return Promise.resolve([]);
      }),
      end: vi.fn().mockResolvedValue(undefined),
    };
    dest = {
      connect: vi.fn().mockResolvedValue(undefined),
      getClient: vi.fn().mockResolvedValue(destClient),
      end: vi.fn().mockResolvedValue(undefined),
    };
    connectionQueue.push(source, dest);
    migrator = new MysqlDataMigrator();
  });

  it('copies no table when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      migrator.migrate(makeConfig('src'), makeConfig('dst'), makePlan(), 1, undefined, undefined, controller.signal)
    ).rejects.toThrow(MigrationCancelledError);

    const sql = destClient.query.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(sql.some((s: string) => s.startsWith('INSERT INTO'))).toBe(false);
  });

  it('stops after the table it was on, rather than finishing the plan', async () => {
    const controller = new AbortController();
    // Abort as soon as the first table's rows land, i.e. mid-run.
    destClient.query.mockImplementation((sql: string) => {
      if (sql.startsWith('INSERT INTO `parent`')) controller.abort();
      return Promise.resolve([]);
    });

    await expect(
      migrator.migrate(makeConfig('src'), makeConfig('dst'), makePlan(), 1, undefined, undefined, controller.signal)
    ).rejects.toThrow(MigrationCancelledError);

    const sql = destClient.query.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(sql.some((s: string) => s.startsWith('INSERT INTO `parent`'))).toBe(true);
    expect(sql.some((s: string) => s.startsWith('INSERT INTO `child`'))).toBe(false);
  });

  it('still re-enables FK checks and releases the client on the way out', async () => {
    const controller = new AbortController();
    controller.abort();

    // Cancellation propagates as a throw; the point of this test is that the
    // destination session is still left clean on the way out.
    await expect(
      migrator.migrate(makeConfig('src'), makeConfig('dst'), makePlan(), 1, undefined, undefined, controller.signal)
    ).rejects.toThrow(MigrationCancelledError);

    const sql = destClient.query.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(sql).toContain('SET SESSION FOREIGN_KEY_CHECKS = 1');
    expect(destClient.release).toHaveBeenCalled();
  });
});

describe('PgDataMigrator cancellation', () => {
  function stubDest() {
    return () => ({
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      getClient: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined),
    });
  }

  const pgPlan: TableMigrationPlan = {
    cleanupOrder: ['users'],
    loadOrder: ['users'],
    levels: [['users']],
    cyclicTables: [],
  };

  it('does not empty the destination when already cancelled', async () => {
    const pool = { run: vi.fn().mockResolvedValue([]), terminate: vi.fn() } as unknown as WorkerPool;
    const destConnection = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      getClient: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const migrator = new PgDataMigrator(pool, () => destConnection);
    const controller = new AbortController();
    controller.abort();

    await expect(
      migrator.migrate(
        makeConfig('src', DatabaseType.POSTGRES),
        makeConfig('dst', DatabaseType.POSTGRES),
        pgPlan,
        2,
        undefined,
        undefined,
        controller.signal
      )
    ).rejects.toThrow(MigrationCancelledError);

    // The TRUNCATE is the single most destructive statement a run issues.
    expect(destConnection.query).not.toHaveBeenCalled();
    expect((pool as unknown as { run: ReturnType<typeof vi.fn> }).run).not.toHaveBeenCalled();
  });

  it('reports a cancelled copy as cancelled rather than as a partial success', async () => {
    const controller = new AbortController();
    // The pool RESOLVES when terminated — it cannot distinguish a killed worker
    // from a crashed one — so the migrator must notice the signal itself.
    const pool = {
      run: vi.fn(async () => {
        controller.abort();
        return [];
      }),
      terminate: vi.fn(),
    } as unknown as WorkerPool;

    const migrator = new PgDataMigrator(pool, stubDest());

    await expect(
      migrator.migrate(
        makeConfig('src', DatabaseType.POSTGRES),
        makeConfig('dst', DatabaseType.POSTGRES),
        pgPlan,
        2,
        undefined,
        undefined,
        controller.signal
      )
    ).rejects.toThrow(MigrationCancelledError);
  });
});

describe('WorkerPool.terminate', () => {
  it('is exposed, so an aborted run has something that actually stops a thread', () => {
    // The gap this closes: an AbortSignal in the parent is invisible to a
    // worker thread running a blocking COPY in another realm.
    expect(typeof new WorkerPool().terminate).toBe('function');
  });

  it('is idempotent — both the abort listener and the caller may reach it', () => {
    const pool = new WorkerPool();
    expect(() => {
      pool.terminate();
      pool.terminate();
    }).not.toThrow();
  });
});
