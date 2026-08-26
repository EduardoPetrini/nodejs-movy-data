import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MssqlDataMigrator } from '../../../src/infrastructure/migration/mssql-data-migrator.adapter';
import { DatabaseType, ConnectionConfig } from '../../../src/domain/types/connection.types';
import { TableMigrationPlan } from '../../../src/domain/types/migration.types';

const connectionQueue: any[] = [];

vi.mock('../../../src/infrastructure/database/mssql/mssql-connection.adapter', () => ({
  MssqlConnection: class {
    constructor() {
      const instance = connectionQueue.shift();
      if (!instance) throw new Error('Missing MssqlConnection mock');
      return instance;
    }
  },
}));

function makeConfig(database: string): ConnectionConfig {
  return {
    type: DatabaseType.MSSQL,
    host: 'localhost',
    port: 1433,
    user: 'sa',
    password: 'pass',
    database,
  };
}

describe('MssqlDataMigrator', () => {
  let source: any;
  let dest: any;
  let destClient: any;
  let migrator: MssqlDataMigrator;
  let plan: TableMigrationPlan;

  beforeEach(() => {
    connectionQueue.length = 0;

    destClient = {
      query: vi.fn().mockResolvedValue([]),
      release: vi.fn(),
    };

    source = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn((sql: string) => {
        // Column name queries
        if (sql.includes('INFORMATION_SCHEMA.COLUMNS') && sql.includes("TABLE_NAME = ?") && !sql.includes('IsIdentity')) {
          if (sql.includes('parent') || (source.query.mock.calls.filter((c: any) => c[0] === sql).length % 2 === 1)) {
            // Return columns based on the parameter
          }
          return Promise.resolve([{ column_name: 'id' }]);
        }
        // Identity column query
        if (sql.includes('IsIdentity')) {
          return Promise.resolve([{ column_name: 'id' }]);
        }
        // Data SELECT queries
        if (sql.includes('FETCH NEXT')) {
          return Promise.resolve([{ id: 1 }]);
        }
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
    migrator = new MssqlDataMigrator();
    plan = {
      cleanupOrder: ['child', 'parent'],
      loadOrder: ['parent', 'child'],
      levels: [['parent'], ['child']],
      cyclicTables: [],
    };
  });

  it('issues NOCHECK CONSTRAINT ALL before clearing, CHECK after loading', async () => {
    // source: columns + identity for parent, then child; data rows return empty second batch
    source.query.mockImplementation((sql: string) => {
      if (sql.includes('IsIdentity')) return Promise.resolve([]);
      if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) return Promise.resolve([{ column_name: 'id' }]);
      if (sql.includes('FETCH NEXT')) return Promise.resolve([]);
      return Promise.resolve([]);
    });

    await migrator.migrate(makeConfig('src'), makeConfig('dst'), plan, 1);

    const destCalls = destClient.query.mock.calls.map((c: any) => c[0]);
    expect(destCalls[0]).toContain('NOCHECK CONSTRAINT ALL');
    expect(destCalls[1]).toContain('NOCHECK CONSTRAINT ALL');
    const lastCalls = destCalls.slice(-2);
    expect(lastCalls.some((s: string) => s.includes('WITH CHECK CHECK CONSTRAINT ALL'))).toBe(true);
    expect(destClient.release).toHaveBeenCalled();
  });

  it('falls back to DELETE when TRUNCATE fails', async () => {
    source.query.mockImplementation((sql: string) => {
      if (sql.includes('IsIdentity')) return Promise.resolve([]);
      if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) return Promise.resolve([{ column_name: 'id' }]);
      return Promise.resolve([]);
    });

    destClient.query.mockImplementation((sql: string) => {
      if (sql.includes('TRUNCATE TABLE [child]')) throw new Error('fk error');
      return Promise.resolve([]);
    });

    await migrator.migrate(makeConfig('src'), makeConfig('dst'), plan, 1);

    const destCalls = destClient.query.mock.calls.map((c: any) => c[0]);
    expect(destCalls).toContain('DELETE FROM [child]');
  });

  it('re-enables constraints even when a table load fails', async () => {
    source.query.mockImplementation((sql: string) => {
      if (sql.includes('IsIdentity')) return Promise.resolve([{ column_name: 'id' }]);
      if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) return Promise.resolve([{ column_name: 'id' }]);
      if (sql.includes('FETCH NEXT')) return Promise.resolve([{ id: 1 }]);
      return Promise.resolve([]);
    });

    destClient.query.mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO [parent]')) throw new Error('insert failed');
      return Promise.resolve([]);
    });

    const result = await migrator.migrate(makeConfig('src'), makeConfig('dst'), plan, 1);

    expect(result.success).toBe(false);
    const destCalls = destClient.query.mock.calls.map((c: any) => c[0]);
    const hasReEnable = destCalls.some((s: string) => s.includes('WITH CHECK CHECK CONSTRAINT ALL'));
    expect(hasReEnable).toBe(true);
    expect(destClient.release).toHaveBeenCalled();
  });

  it('wraps IDENTITY tables with SET IDENTITY_INSERT ON/OFF', async () => {
    // loadOrder: ['parent', 'child']
    // For each table: getColumnNames, getIdentityColumns, then paginated SELECT
    // parent: has identity; child: no identity
    source.query
      // parent: getColumnNames
      .mockResolvedValueOnce([{ column_name: 'id' }])
      // parent: getIdentityColumns → has identity
      .mockResolvedValueOnce([{ column_name: 'id' }])
      // parent: first page (1 row), second page (empty)
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([])
      // child: getColumnNames
      .mockResolvedValueOnce([{ column_name: 'id' }])
      // child: getIdentityColumns → no identity
      .mockResolvedValueOnce([])
      // child: first page (empty)
      .mockResolvedValueOnce([]);

    await migrator.migrate(makeConfig('src'), makeConfig('dst'), plan, 1);

    const destCalls = destClient.query.mock.calls.map((c: any) => c[0]);
    expect(destCalls.some((s: string) => s.includes('SET IDENTITY_INSERT') && s.includes('ON'))).toBe(true);
    expect(destCalls.some((s: string) => s.includes('SET IDENTITY_INSERT') && s.includes('OFF'))).toBe(true);
  });
});
