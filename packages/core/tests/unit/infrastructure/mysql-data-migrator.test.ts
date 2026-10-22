import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MysqlDataMigrator } from '../../../src/infrastructure/migration/mysql-data-migrator.adapter';
import { DatabaseType, ConnectionConfig } from '../../../src/domain/types/connection.types';
import { TableMigrationPlan } from '../../../src/domain/types/migration.types';

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

function makeConfig(database: string): ConnectionConfig {
  return {
    type: DatabaseType.MYSQL,
    host: 'localhost',
    port: 3306,
    user: 'u',
    password: 'p',
    database,
  };
}

describe('MysqlDataMigrator', () => {
  let source: any;
  let dest: any;
  let destClient: any;
  let migrator: MysqlDataMigrator;
  let plan: TableMigrationPlan;

  beforeEach(() => {
    connectionQueue.length = 0;

    destClient = {
      query: vi.fn(),
      release: vi.fn(),
    };

    source = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn((sql: string) => {
        if (sql.includes('SHOW COLUMNS FROM `parent`')) return Promise.resolve([{ Field: 'id' }]);
        if (sql.includes('SHOW COLUMNS FROM `child`')) {
          return Promise.resolve([{ Field: 'id' }, { Field: 'parent_id' }]);
        }
        if (sql.includes('SELECT `id` FROM `parent`')) return Promise.resolve([{ id: 1 }]);
        if (sql.includes('SELECT `id`, `parent_id` FROM `child`')) {
          return Promise.resolve([{ id: 2, parent_id: 1 }]);
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
    migrator = new MysqlDataMigrator();
    plan = {
      cleanupOrder: ['child', 'parent'],
      loadOrder: ['parent', 'child'],
      levels: [['parent'], ['child']],
      cyclicTables: [],
    };
  });

  it('clears tables in cleanup order, loads in dependency order, and scopes FK checks to the session', async () => {
    destClient.query.mockResolvedValue([]);

    await migrator.migrate(makeConfig('src'), makeConfig('dst'), plan, 1);

    const sqlCalls = destClient.query.mock.calls.map((call: unknown[]) => call[0]);
    expect(sqlCalls).toEqual([
      'SET SESSION FOREIGN_KEY_CHECKS = 0',
      'TRUNCATE TABLE `child`',
      'TRUNCATE TABLE `parent`',
      'INSERT INTO `parent` (`id`) VALUES (?)',
      'INSERT INTO `child` (`id`, `parent_id`) VALUES (?, ?)',
      'SET SESSION FOREIGN_KEY_CHECKS = 1',
    ]);
    expect(destClient.release).toHaveBeenCalled();
  });

  it('falls back to DELETE when TRUNCATE fails', async () => {
    destClient.query.mockImplementation((sql: string) => {
      if (sql === 'TRUNCATE TABLE `child`') throw new Error('fk constraint');
      return Promise.resolve([]);
    });

    await migrator.migrate(makeConfig('src'), makeConfig('dst'), plan, 1);

    const sqlCalls = destClient.query.mock.calls.map((call: unknown[]) => call[0]);
    expect(sqlCalls).toContain('DELETE FROM `child`');
  });

  it('re-enables FK checks even when a table load fails', async () => {
    destClient.query.mockImplementation((sql: string) => {
      if (sql.startsWith('INSERT INTO `child`')) throw new Error('insert failed');
      return Promise.resolve([]);
    });

    const result = await migrator.migrate(makeConfig('src'), makeConfig('dst'), plan, 1);

    expect(result.success).toBe(false);
    expect(destClient.query).toHaveBeenLastCalledWith('SET SESSION FOREIGN_KEY_CHECKS = 1');
    expect(destClient.release).toHaveBeenCalled();
  });
});
