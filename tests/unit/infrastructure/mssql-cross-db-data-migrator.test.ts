import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MssqlCrossDbDataMigrator } from '../../../src/infrastructure/migration/mssql-cross-db-data-migrator';
import { DatabaseType, ConnectionConfig } from '../../../src/domain/types/connection.types';
import { TableMigrationPlan } from '../../../src/domain/types/migration.types';
import { DataMigrationError } from '../../../src/domain/errors/migration.errors';

// ---------------------------------------------------------------------------
// Mock all three connection adapters
// ---------------------------------------------------------------------------

const mssqlQueue: any[] = [];
const pgQueue: any[] = [];
const mysqlQueue: any[] = [];

vi.mock('../../../src/infrastructure/database/mssql/mssql-connection.adapter', () => ({
  MssqlConnection: class {
    constructor() {
      const instance = mssqlQueue.shift();
      if (!instance) throw new Error('Missing MssqlConnection mock');
      return instance;
    }
  },
}));

vi.mock('../../../src/infrastructure/database/pg/pg-connection.adapter', () => ({
  PgConnection: class {
    constructor() {
      const instance = pgQueue.shift();
      if (!instance) throw new Error('Missing PgConnection mock');
      return instance;
    }
  },
}));

vi.mock('../../../src/infrastructure/database/mysql/mysql-connection.adapter', () => ({
  MysqlConnection: class {
    constructor() {
      const instance = mysqlQueue.shift();
      if (!instance) throw new Error('Missing MysqlConnection mock');
      return instance;
    }
  },
}));

function makeConfig(type: DatabaseType, database = 'testdb'): ConnectionConfig {
  return { type, host: 'localhost', port: 1433, user: 'sa', password: 'pass', database };
}

function makePlan(tables: string[]): TableMigrationPlan {
  return {
    cleanupOrder: [...tables].reverse(),
    loadOrder: tables,
    levels: [tables],
    cyclicTables: [],
  };
}

function makeClient(queryImpl?: (sql: string) => any) {
  return {
    query: vi.fn().mockImplementation(queryImpl ?? (() => Promise.resolve([]))),
    release: vi.fn(),
  };
}

describe('MssqlCrossDbDataMigrator', () => {
  let migrator: MssqlCrossDbDataMigrator;

  beforeEach(() => {
    migrator = new MssqlCrossDbDataMigrator();
    mssqlQueue.length = 0;
    pgQueue.length = 0;
    mysqlQueue.length = 0;
  });

  describe('assertSupportedPair', () => {
    it('throws DataMigrationError for MySQL→PG (not an MSSQL pair)', async () => {
      const src = makeConfig(DatabaseType.MYSQL);
      const dst = makeConfig(DatabaseType.POSTGRES);
      await expect(
        migrator.migrate(src, dst, makePlan([]), 1)
      ).rejects.toThrow(DataMigrationError);
    });

    it('accepts MSSQL→PG', async () => {
      const destClient = makeClient();
      const src = { connect: vi.fn(), query: vi.fn().mockResolvedValue([]), end: vi.fn() };
      const dst = { connect: vi.fn(), query: vi.fn().mockResolvedValue([]), end: vi.fn(), getClient: vi.fn().mockResolvedValue(destClient) };
      mssqlQueue.push(src);
      pgQueue.push(dst);
      const result = await migrator.migrate(makeConfig(DatabaseType.MSSQL), makeConfig(DatabaseType.POSTGRES), makePlan([]), 1);
      expect(result.success).toBe(true);
    });
  });

  describe('MSSQL → PostgreSQL', () => {
    it('copies rows from MSSQL to PG and returns count', async () => {
      const plan = makePlan(['users']);

      const mssqlConn = {
        connect: vi.fn(),
        query: vi.fn()
          .mockResolvedValueOnce([{ column_name: 'id' }, { column_name: 'name' }])  // getColumnNames
          .mockResolvedValueOnce([{ id: 1, name: 'Alice' }])  // first page
          .mockResolvedValueOnce([]),  // second page empty → done
        end: vi.fn(),
      };

      const pgConn = {
        connect: vi.fn(),
        query: vi.fn().mockResolvedValue([]),  // TRUNCATE + INSERT
        end: vi.fn(),
      };

      mssqlQueue.push(mssqlConn);
      pgQueue.push(pgConn);

      const result = await migrator.migrate(
        makeConfig(DatabaseType.MSSQL),
        makeConfig(DatabaseType.POSTGRES),
        plan,
        1
      );

      expect(result.tables[0].rowsCopied).toBe(1);
      expect(result.success).toBe(true);
      const pgCalls = pgConn.query.mock.calls.map((c: any) => c[0]);
      expect(pgCalls.some((s: string) => s.includes('INSERT INTO'))).toBe(true);
    });
  });

  describe('MSSQL → MySQL', () => {
    it('copies rows from MSSQL to MySQL', async () => {
      const plan = makePlan(['products']);

      const mssqlConn = {
        connect: vi.fn(),
        query: vi.fn()
          .mockResolvedValueOnce([{ column_name: 'id' }])
          .mockResolvedValueOnce([{ id: 1 }])
          .mockResolvedValueOnce([]),
        end: vi.fn(),
      };

      const mysqlClient = makeClient();
      const mysqlConn = {
        connect: vi.fn(),
        getClient: vi.fn().mockResolvedValue(mysqlClient),
        end: vi.fn(),
      };

      mssqlQueue.push(mssqlConn);
      mysqlQueue.push(mysqlConn);

      const result = await migrator.migrate(
        makeConfig(DatabaseType.MSSQL),
        makeConfig(DatabaseType.MYSQL),
        plan,
        1
      );

      expect(result.tables[0].rowsCopied).toBe(1);
      const calls = mysqlClient.query.mock.calls.map((c: any) => c[0]);
      expect(calls.some((s: string) => s.includes('INSERT INTO'))).toBe(true);
    });
  });

  describe('PostgreSQL → MSSQL', () => {
    it('uses NOCHECK/CHECK constraint and IDENTITY_INSERT for identity tables', async () => {
      const plan = makePlan(['orders']);

      const pgConn = {
        connect: vi.fn(),
        query: vi.fn()
          .mockResolvedValueOnce([{ column_name: 'id' }])  // column names
          .mockResolvedValueOnce([{ id: 1 }])              // first page
          .mockResolvedValueOnce([]),                       // second page empty
        end: vi.fn(),
      };

      const destClient = makeClient();
      const mssqlConn = {
        connect: vi.fn(),
        query: vi.fn().mockResolvedValueOnce([{ column_name: 'id' }]),  // identity columns check
        getClient: vi.fn().mockResolvedValue(destClient),
        end: vi.fn(),
      };

      pgQueue.push(pgConn);
      mssqlQueue.push(mssqlConn);

      await migrator.migrate(
        makeConfig(DatabaseType.POSTGRES),
        makeConfig(DatabaseType.MSSQL),
        plan,
        1
      );

      const destCalls = destClient.query.mock.calls.map((c: any) => c[0]);
      expect(destCalls.some((s: string) => s.includes('NOCHECK CONSTRAINT ALL'))).toBe(true);
      expect(destCalls.some((s: string) => s.includes('IDENTITY_INSERT'))).toBe(true);
      expect(destCalls.some((s: string) => s.includes('CHECK CONSTRAINT ALL'))).toBe(true);
    });
  });

  describe('MySQL → MSSQL', () => {
    it('copies rows from MySQL to MSSQL', async () => {
      const plan = makePlan(['customers']);

      const mysqlConn = {
        connect: vi.fn(),
        query: vi.fn()
          .mockResolvedValueOnce([{ Field: 'id' }])  // SHOW COLUMNS
          .mockResolvedValueOnce([{ id: 42 }])        // first page
          .mockResolvedValueOnce([]),                  // done
        end: vi.fn(),
      };

      const destClient = makeClient();
      const mssqlConn = {
        connect: vi.fn(),
        query: vi.fn().mockResolvedValueOnce([]),  // identity columns (none)
        getClient: vi.fn().mockResolvedValue(destClient),
        end: vi.fn(),
      };

      mysqlQueue.push(mysqlConn);
      mssqlQueue.push(mssqlConn);

      const result = await migrator.migrate(
        makeConfig(DatabaseType.MYSQL),
        makeConfig(DatabaseType.MSSQL),
        plan,
        1
      );

      expect(result.tables[0].rowsCopied).toBe(1);
      const destCalls = destClient.query.mock.calls.map((c: any) => c[0]);
      expect(destCalls.some((s: string) => s.includes('INSERT INTO'))).toBe(true);
    });
  });
});
