import { describe, it, expect, beforeEach } from 'vitest';
import { MssqlSchemaSynchronizer } from '../../../../src/infrastructure/database/mssql/mssql-schema-synchronizer.adapter';
import { createMockConnection } from '../../../helpers/mock-database';
import { DatabaseSchema, TableSchema } from '../../../../src/domain/types/schema.types';
import { SchemaDiff } from '../../../../src/domain/types/migration.types';
import { IDatabaseConnection } from '../../../../src/domain/ports/database.port';

function makeSync() {
  return new MssqlSchemaSynchronizer();
}

function makeTable(name: string, overrides: Partial<TableSchema> = {}): TableSchema {
  return {
    name,
    columns: [
      {
        name: 'id',
        dataType: 'int',
        isNullable: false,
        defaultValue: null,
        characterMaxLength: null,
        numericPrecision: null,
        numericScale: null,
        autoIncrement: true,
      },
    ],
    constraints: [],
    indexes: [],
    ...overrides,
  };
}

function makeSchema(tables: TableSchema[]): DatabaseSchema {
  return { tables, sequences: [], enums: [] };
}

function emptyDiff(): SchemaDiff {
  return {
    tablesToCreate: [],
    tablesToDrop: [],
    columnsToAdd: [],
    columnsToDrop: [],
    columnsToAlter: [],
    constraintsToAdd: [],
    constraintsToDrop: [],
    indexesToCreate: [],
    indexesToDrop: [],
    sequencesToCreate: [],
    enumsToCreate: [],
  };
}

describe('MssqlSchemaSynchronizer', () => {
  let sync: MssqlSchemaSynchronizer;
  let connection: IDatabaseConnection;

  beforeEach(() => {
    sync = makeSync();
    connection = createMockConnection();
  });

  describe('diff()', () => {
    it('returns empty diff for identical schemas', () => {
      const table = makeTable('users');
      const schema = makeSchema([table]);
      const diff = sync.diff(schema, schema);
      expect(diff.tablesToCreate).toHaveLength(0);
      expect(diff.tablesToDrop).toHaveLength(0);
      expect(diff.columnsToAdd).toHaveLength(0);
    });

    it('detects new table to create', () => {
      const source = makeSchema([makeTable('users')]);
      const target = makeSchema([]);
      const diff = sync.diff(source, target);
      expect(diff.tablesToCreate).toHaveLength(1);
      expect(diff.tablesToCreate[0].name).toBe('users');
    });

    it('detects table to drop', () => {
      const source = makeSchema([]);
      const target = makeSchema([makeTable('old_table')]);
      const diff = sync.diff(source, target);
      expect(diff.tablesToDrop).toContain('old_table');
    });

    it('detects column to add', () => {
      const source = makeSchema([makeTable('users', {
        columns: [
          { name: 'id', dataType: 'int', isNullable: false, defaultValue: null, characterMaxLength: null, numericPrecision: null, numericScale: null },
          { name: 'email', dataType: 'nvarchar(255)', isNullable: false, defaultValue: null, characterMaxLength: 255, numericPrecision: null, numericScale: null },
        ],
      })]);
      const target = makeSchema([makeTable('users')]);
      const diff = sync.diff(source, target);
      expect(diff.columnsToAdd).toHaveLength(1);
      expect(diff.columnsToAdd[0].column.name).toBe('email');
    });

    it('detects FK constraint to add for new table', () => {
      const table = makeTable('orders', {
        constraints: [{
          name: 'FK_orders_user',
          type: 'FOREIGN KEY',
          columns: ['user_id'],
          referencedTable: 'users',
          referencedColumns: ['id'],
        }],
      });
      const diff = sync.diff(makeSchema([table]), makeSchema([]));
      expect(diff.constraintsToAdd).toHaveLength(1);
      expect(diff.constraintsToAdd[0].constraint.name).toBe('FK_orders_user');
    });
  });

  describe('apply()', () => {
    it('executes CREATE TABLE with bracketed identifiers', async () => {
      const diff = emptyDiff();
      diff.tablesToCreate = [makeTable('my_table')];
      await sync.apply(connection, diff);
      const calls = (connection.query as ReturnType<typeof import('vitest').vi.fn>).mock.calls;
      const createStmt = calls.find((c) => String(c[0]).includes('CREATE TABLE'))?.[0] as string;
      expect(createStmt).toContain('[my_table]');
    });

    it('generates IDENTITY(1,1) for autoIncrement columns', async () => {
      const diff = emptyDiff();
      diff.tablesToCreate = [makeTable('t')];
      await sync.apply(connection, diff);
      const calls = (connection.query as ReturnType<typeof import('vitest').vi.fn>).mock.calls;
      const createStmt = calls.find((c) => String(c[0]).includes('CREATE TABLE'))?.[0] as string;
      expect(createStmt).toContain('IDENTITY(1,1)');
    });

    it('executes DROP CONSTRAINT with bracketed names', async () => {
      const diff = emptyDiff();
      diff.constraintsToDrop = [{ tableName: 'orders', constraintName: 'FK_orders_user', constraintType: 'FOREIGN KEY' }];
      await sync.apply(connection, diff);
      const calls = (connection.query as ReturnType<typeof import('vitest').vi.fn>).mock.calls;
      expect(calls[0][0]).toContain('DROP CONSTRAINT');
      expect(calls[0][0]).toContain('[FK_orders_user]');
    });

    it('executes ADD COLUMN with bracketed name', async () => {
      const diff = emptyDiff();
      diff.columnsToAdd = [{ tableName: 'users', column: { name: 'email', dataType: 'nvarchar(255)', isNullable: true, defaultValue: null, characterMaxLength: 255, numericPrecision: null, numericScale: null } }];
      await sync.apply(connection, diff);
      const calls = (connection.query as ReturnType<typeof import('vitest').vi.fn>).mock.calls;
      expect(calls[0][0]).toContain('[email]');
    });

    it('executes IF OBJECT_ID check for DROP TABLE', async () => {
      const diff = emptyDiff();
      diff.tablesToDrop = ['old_table'];
      await sync.apply(connection, diff);
      const calls = (connection.query as ReturnType<typeof import('vitest').vi.fn>).mock.calls;
      const dropStmt = calls[0][0] as string;
      expect(dropStmt).toContain('OBJECT_ID');
      expect(dropStmt).toContain('[old_table]');
    });

    it('uses ALTER COLUMN (not MODIFY) for column type changes', async () => {
      const diff = emptyDiff();
      diff.columnsToAlter = [{ tableName: 'users', diff: { columnName: 'age', sourceType: 'bigint', targetType: 'int' } }];
      await sync.apply(connection, diff);
      const calls = (connection.query as ReturnType<typeof import('vitest').vi.fn>).mock.calls;
      expect(calls[0][0]).toContain('ALTER COLUMN');
    });
  });

  describe('disableTriggers() and enableTriggers()', () => {
    it('issues NOCHECK CONSTRAINT ALL per table', async () => {
      await sync.disableTriggers(connection, ['users', 'orders']);
      const calls = (connection.query as ReturnType<typeof import('vitest').vi.fn>).mock.calls;
      expect(calls[0][0]).toContain('NOCHECK CONSTRAINT ALL');
      expect(calls[0][0]).toContain('[users]');
      expect(calls[1][0]).toContain('[orders]');
    });

    it('issues WITH CHECK CHECK CONSTRAINT ALL per table', async () => {
      await sync.enableTriggers(connection, ['users']);
      const calls = (connection.query as ReturnType<typeof import('vitest').vi.fn>).mock.calls;
      expect(calls[0][0]).toContain('WITH CHECK CHECK CONSTRAINT ALL');
      expect(calls[0][0]).toContain('[users]');
    });
  });

  describe('createIndexes()', () => {
    it('creates non-unique index with bracketed names', async () => {
      const diff = emptyDiff();
      diff.indexesToCreate = [{ tableName: 'users', index: { name: 'IX_users_email', columns: ['email'], isUnique: false, method: 'btree' } }];
      await sync.createIndexes(connection, diff);
      const calls = (connection.query as ReturnType<typeof import('vitest').vi.fn>).mock.calls;
      expect(calls[0][0]).toContain('CREATE INDEX [IX_users_email]');
    });

    it('creates unique index', async () => {
      const diff = emptyDiff();
      diff.indexesToCreate = [{ tableName: 'users', index: { name: 'UQ_users_email', columns: ['email'], isUnique: true, method: 'btree' } }];
      await sync.createIndexes(connection, diff);
      const calls = (connection.query as ReturnType<typeof import('vitest').vi.fn>).mock.calls;
      expect(calls[0][0]).toContain('CREATE UNIQUE INDEX');
    });
  });

  describe('resetSequences()', () => {
    const vfn = (c: any) => c.query as ReturnType<typeof import('vitest').vi.fn>;

    it('reads MAX from the destination and reseeds from it', async () => {
      const source = createMockConnection();
      const dest = createMockConnection();
      vfn(dest).mockResolvedValueOnce([{ max_id: 100 }]);

      await sync.resetSequences(source, dest, [], [makeTable('users')]);

      const destCalls = vfn(dest).mock.calls;
      expect(destCalls[0][0]).toContain('MAX');
      expect(destCalls[1][0]).toContain('DBCC CHECKIDENT');
      expect(destCalls[1][0]).toContain('users');
      expect(destCalls[1][0]).toContain('100');
      // The source may be MySQL or PostgreSQL, where [bracket] quoting is a
      // syntax error — this step must not touch it.
      expect(vfn(source)).not.toHaveBeenCalled();
    });

    it('queries MAX on the actual identity column, not a hardcoded "id"', async () => {
      const source = createMockConnection();
      const dest = createMockConnection();
      vfn(dest).mockResolvedValueOnce([{ max_id: 42 }]);

      const table = makeTable('orders', {
        columns: [
          {
            name: 'OrderID',
            dataType: 'int',
            isNullable: false,
            defaultValue: null,
            characterMaxLength: null,
            numericPrecision: null,
            numericScale: null,
            autoIncrement: true,
          },
        ],
      });
      await sync.resetSequences(source, dest, [], [table]);

      const destCalls = vfn(dest).mock.calls;
      expect(destCalls[0][0]).toContain('[OrderID]');
      expect(destCalls[0][0]).not.toContain('[id]');
      expect(destCalls).toHaveLength(2);
      expect(destCalls[1][0]).toContain('RESEED, 42');
    });

    it('does not reseed when the destination table is empty', async () => {
      const source = createMockConnection();
      const dest = createMockConnection();
      vfn(dest).mockResolvedValueOnce([{ max_id: null }]);

      await sync.resetSequences(source, dest, [], [makeTable('users')]);

      expect(vfn(dest).mock.calls).toHaveLength(1);
    });

    it('skips tables without identity columns', async () => {
      const source = createMockConnection();
      const dest = createMockConnection();

      const table = makeTable('users', {
        columns: [{ name: 'id', dataType: 'int', isNullable: false, defaultValue: null, characterMaxLength: null, numericPrecision: null, numericScale: null, autoIncrement: false }],
      });
      await sync.resetSequences(source, dest, [], [table]);

      expect(vfn(dest).mock.calls).toHaveLength(0);
    });
  });
});
