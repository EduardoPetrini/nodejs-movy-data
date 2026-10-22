import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MysqlSchemaSynchronizer } from '../../../../src/infrastructure/database/mysql/mysql-schema-synchronizer.adapter';
import { createMockConnection } from '../../../helpers/mock-database';
import { DatabaseSchema, TableSchema } from '../../../../src/domain/types/schema.types';
import { SchemaDiff } from '../../../../src/domain/types/migration.types';
import { IDatabaseConnection } from '../../../../src/domain/ports/database.port';

function emptySchema(): DatabaseSchema {
  return { tables: [], sequences: [], enums: [] };
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

function makeTable(name: string, overrides: Partial<TableSchema> = {}): TableSchema {
  return {
    name,
    columns: [],
    constraints: [],
    indexes: [],
    ...overrides,
  };
}

describe('MysqlSchemaSynchronizer', () => {
  let sync: MysqlSchemaSynchronizer;
  let connection: IDatabaseConnection;

  beforeEach(() => {
    sync = new MysqlSchemaSynchronizer();
    connection = createMockConnection();
  });

  // ---------------------------------------------------------------------------
  // diff()
  // ---------------------------------------------------------------------------

  describe('diff()', () => {
    it('returns empty diff for identical schemas', () => {
      const schema: DatabaseSchema = {
        tables: [makeTable('users')],
        sequences: [],
        enums: [],
      };
      const diff = sync.diff(schema, schema);
      expect(diff.tablesToCreate).toHaveLength(0);
      expect(diff.tablesToDrop).toHaveLength(0);
    });

    it('detects tables to create', () => {
      const source: DatabaseSchema = { tables: [makeTable('users')], sequences: [], enums: [] };
      const diff = sync.diff(source, emptySchema());
      expect(diff.tablesToCreate.map((t) => t.name)).toContain('users');
    });

    it('detects tables to drop', () => {
      const target: DatabaseSchema = { tables: [makeTable('stale')], sequences: [], enums: [] };
      const diff = sync.diff(emptySchema(), target);
      expect(diff.tablesToDrop).toContain('stale');
    });

    it('detects columns to add', () => {
      const source: DatabaseSchema = {
        tables: [
          makeTable('users', {
            columns: [
              { name: 'id', dataType: 'int(11)', isNullable: false, defaultValue: null, characterMaxLength: null, numericPrecision: null, numericScale: null },
              { name: 'email', dataType: 'varchar(255)', isNullable: false, defaultValue: null, characterMaxLength: 255, numericPrecision: null, numericScale: null },
            ],
          }),
        ],
        sequences: [],
        enums: [],
      };
      const target: DatabaseSchema = {
        tables: [
          makeTable('users', {
            columns: [
              { name: 'id', dataType: 'int(11)', isNullable: false, defaultValue: null, characterMaxLength: null, numericPrecision: null, numericScale: null },
            ],
          }),
        ],
        sequences: [],
        enums: [],
      };
      const diff = sync.diff(source, target);
      expect(diff.columnsToAdd).toHaveLength(1);
      expect(diff.columnsToAdd[0].column.name).toBe('email');
    });

    it('always returns empty sequences and enums (MySQL has no standalone sequences)', () => {
      const diff = sync.diff(emptySchema(), emptySchema());
      expect(diff.sequencesToCreate).toHaveLength(0);
      expect(diff.enumsToCreate).toHaveLength(0);
    });

    it('enqueues FK constraints and secondary indexes for newly created tables', () => {
      const source: DatabaseSchema = {
        tables: [
          makeTable('execution_entity', {
            columns: [
              { name: 'id', dataType: 'int', isNullable: false, defaultValue: null, characterMaxLength: null, numericPrecision: null, numericScale: null, autoIncrement: true },
              { name: 'workflowId', dataType: 'varchar(36)', isNullable: false, defaultValue: null, characterMaxLength: 36, numericPrecision: null, numericScale: null },
            ],
            constraints: [
              { name: 'PRIMARY', type: 'PRIMARY KEY', columns: ['id'] },
              {
                name: 'fk_execution_entity_workflow_id',
                type: 'FOREIGN KEY',
                columns: ['workflowId'],
                referencedTable: 'workflow_entity',
                referencedColumns: ['id'],
                onDelete: 'CASCADE',
              },
            ],
            indexes: [
              { name: 'IDX_execution_entity_deletedAt', columns: ['deletedAt'], isUnique: false, method: 'btree' },
            ],
          }),
        ],
        sequences: [],
        enums: [],
      };

      const diff = sync.diff(source, emptySchema());

      expect(diff.tablesToCreate).toHaveLength(1);
      expect(diff.constraintsToAdd.map((c) => c.constraint.name)).toContain('fk_execution_entity_workflow_id');
      expect(diff.indexesToCreate.map((i) => i.index.name)).toContain('IDX_execution_entity_deletedAt');
    });
  });

  // ---------------------------------------------------------------------------
  // apply()
  // ---------------------------------------------------------------------------

  describe('apply()', () => {
    it('does nothing when diff is empty', async () => {
      await sync.apply(connection, emptyDiff());
      expect(connection.query).not.toHaveBeenCalled();
    });

    it('emits table-level AUTO_INCREMENT and source engine/charset/collation in CREATE TABLE', async () => {
      const diff: SchemaDiff = {
        ...emptyDiff(),
        tablesToCreate: [
          makeTable('execution_entity', {
            engine: 'InnoDB',
            characterSet: 'utf8mb4',
            collation: 'utf8mb4_0900_ai_ci',
            autoIncrement: 218796,
            columns: [
              { name: 'id', dataType: 'int', isNullable: false, defaultValue: null, characterMaxLength: null, numericPrecision: null, numericScale: null, autoIncrement: true },
            ],
            constraints: [{ name: 'PRIMARY', type: 'PRIMARY KEY', columns: ['id'] }],
          }),
        ],
      };

      await sync.apply(connection, diff);

      const calls = (connection.query as ReturnType<typeof vi.fn>).mock.calls as [string][];
      const createCall = calls.find(([sql]) => sql.includes('CREATE TABLE'))!;
      expect(createCall[0]).toContain('AUTO_INCREMENT=218796');
      expect(createCall[0]).toContain('DEFAULT CHARSET=utf8mb4');
      expect(createCall[0]).toContain('COLLATE=utf8mb4_0900_ai_ci');
    });

    it('emits column-level COLLATE when column collation differs from table collation', async () => {
      const diff: SchemaDiff = {
        ...emptyDiff(),
        tablesToCreate: [
          makeTable('mixed', {
            collation: 'utf8mb4_0900_ai_ci',
            columns: [
              { name: 'a', dataType: 'varchar(10)', isNullable: true, defaultValue: null, characterMaxLength: 10, numericPrecision: null, numericScale: null, characterSet: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' },
              { name: 'b', dataType: 'varchar(10)', isNullable: true, defaultValue: null, characterMaxLength: 10, numericPrecision: null, numericScale: null, characterSet: 'utf8mb4', collation: 'utf8mb4_unicode_ci' },
            ],
          }),
        ],
      };

      await sync.apply(connection, diff);

      const calls = (connection.query as ReturnType<typeof vi.fn>).mock.calls as [string][];
      const createCall = calls.find(([sql]) => sql.includes('CREATE TABLE'))!;
      // Matching collation → no column-level COLLATE emitted
      expect(createCall[0]).toMatch(/`a` varchar\(10\)(?! CHARACTER SET)/);
      // Differing collation → column-level COLLATE emitted
      expect(createCall[0]).toContain('`b` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    });

    it('emits AUTO_INCREMENT in column DDL when autoIncrement is set', async () => {
      const diff: SchemaDiff = {
        ...emptyDiff(),
        tablesToCreate: [
          makeTable('counters', {
            columns: [
              { name: 'id', dataType: 'int', isNullable: false, defaultValue: null, characterMaxLength: null, numericPrecision: null, numericScale: null, autoIncrement: true },
            ],
            constraints: [{ name: 'PRIMARY', type: 'PRIMARY KEY', columns: ['id'] }],
          }),
        ],
      };

      await sync.apply(connection, diff);

      const calls = (connection.query as ReturnType<typeof vi.fn>).mock.calls as [string][];
      const createCall = calls.find(([sql]) => sql.includes('CREATE TABLE'))!;
      expect(createCall[0]).toContain('AUTO_INCREMENT');
    });

    it('generates CREATE TABLE with ENGINE=InnoDB', async () => {
      const diff: SchemaDiff = {
        ...emptyDiff(),
        tablesToCreate: [
          makeTable('products', {
            columns: [
              { name: 'id', dataType: 'int(11)', isNullable: false, defaultValue: null, characterMaxLength: null, numericPrecision: null, numericScale: null },
            ],
          }),
        ],
      };

      await sync.apply(connection, diff);

      const calls = (connection.query as ReturnType<typeof vi.fn>).mock.calls as [string][];
      const createCall = calls.find(([sql]) => sql.includes('CREATE TABLE'));
      expect(createCall).toBeDefined();
      expect(createCall![0]).toContain('ENGINE=InnoDB');
      expect(createCall![0]).toContain('`products`');
    });

    it('uses backtick identifiers', async () => {
      const diff: SchemaDiff = {
        ...emptyDiff(),
        tablesToCreate: [
          makeTable('my_table', {
            columns: [
              { name: 'my_column', dataType: 'varchar(50)', isNullable: true, defaultValue: null, characterMaxLength: 50, numericPrecision: null, numericScale: null },
            ],
          }),
        ],
      };

      await sync.apply(connection, diff);

      const calls = (connection.query as ReturnType<typeof vi.fn>).mock.calls as [string][];
      const createCall = calls.find(([sql]) => sql.includes('CREATE TABLE'))!;
      expect(createCall[0]).toContain('`my_table`');
      expect(createCall[0]).toContain('`my_column`');
    });

    it('generates ADD COLUMN statement', async () => {
      const diff: SchemaDiff = {
        ...emptyDiff(),
        columnsToAdd: [{
          tableName: 'users',
          column: { name: 'phone', dataType: 'varchar(20)', isNullable: true, defaultValue: null, characterMaxLength: 20, numericPrecision: null, numericScale: null },
        }],
      };

      await sync.apply(connection, diff);

      const calls = (connection.query as ReturnType<typeof vi.fn>).mock.calls as [string][];
      const addCall = calls.find(([sql]) => sql.includes('ADD COLUMN'))!;
      expect(addCall[0]).toContain('`users`');
      expect(addCall[0]).toContain('`phone`');
    });

    it('generates MODIFY COLUMN statement for type changes', async () => {
      const diff: SchemaDiff = {
        ...emptyDiff(),
        columnsToAlter: [{
          tableName: 'users',
          diff: { columnName: 'status', sourceType: 'varchar(50)', targetType: 'varchar(20)' },
        }],
      };

      await sync.apply(connection, diff);

      const calls = (connection.query as ReturnType<typeof vi.fn>).mock.calls as [string][];
      const modifyCall = calls.find(([sql]) => sql.includes('MODIFY COLUMN'))!;
      expect(modifyCall[0]).toContain('`status`');
      expect(modifyCall[0]).toContain('varchar(50)');
    });

    it('throws SchemaSyncError on statement failure', async () => {
      (connection.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('syntax error'));

      const diff: SchemaDiff = {
        ...emptyDiff(),
        tablesToCreate: [makeTable('bad_table', {
          columns: [{ name: 'x', dataType: 'int', isNullable: false, defaultValue: null, characterMaxLength: null, numericPrecision: null, numericScale: null }],
        })],
      };

      await expect(sync.apply(connection, diff)).rejects.toThrow(/Schema sync failed/);
    });
  });

  // ---------------------------------------------------------------------------
  // disableTriggers() / enableTriggers()
  // ---------------------------------------------------------------------------

  describe('disableTriggers()', () => {
    it('sets FOREIGN_KEY_CHECKS = 0', async () => {
      await sync.disableTriggers(connection, ['users', 'orders']);
      const calls = (connection.query as ReturnType<typeof vi.fn>).mock.calls as [string][];
      expect(calls[0][0]).toContain('FOREIGN_KEY_CHECKS = 0');
      // Called only once regardless of table count
      expect(calls).toHaveLength(1);
    });
  });

  describe('enableTriggers()', () => {
    it('sets FOREIGN_KEY_CHECKS = 1', async () => {
      await sync.enableTriggers(connection, ['users']);
      const calls = (connection.query as ReturnType<typeof vi.fn>).mock.calls as [string][];
      expect(calls[0][0]).toContain('FOREIGN_KEY_CHECKS = 1');
    });
  });

  // ---------------------------------------------------------------------------
  // resetSequences() — no-op
  // ---------------------------------------------------------------------------

  describe('resetSequences()', () => {
    it('is a no-op when no tables with autoIncrement are passed', async () => {
      await sync.resetSequences(connection, connection, []);
      expect(connection.query).not.toHaveBeenCalled();
    });

    it('issues ALTER TABLE ... AUTO_INCREMENT for each table with a counter', async () => {
      await sync.resetSequences(connection, connection, [], [
        makeTable('execution_entity', { autoIncrement: 218796 }),
        makeTable('users', { autoIncrement: null }),
        makeTable('orders', { autoIncrement: 1 }),
      ]);

      const calls = (connection.query as ReturnType<typeof vi.fn>).mock.calls as [string][];
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toContain('ALTER TABLE `execution_entity` AUTO_INCREMENT = 218796');
    });
  });

  // ---------------------------------------------------------------------------
  // createIndexes()
  // ---------------------------------------------------------------------------

  describe('createIndexes()', () => {
    it('creates non-unique indexes', async () => {
      const diff: SchemaDiff = {
        ...emptyDiff(),
        indexesToCreate: [{
          tableName: 'users',
          index: { name: 'idx_email', columns: ['email'], isUnique: false, method: 'btree' },
        }],
      };

      await sync.createIndexes(connection, diff);

      const calls = (connection.query as ReturnType<typeof vi.fn>).mock.calls as [string][];
      const idxCall = calls.find(([sql]) => sql.includes('CREATE') && sql.includes('INDEX'))!;
      expect(idxCall[0]).not.toContain('UNIQUE');
      expect(idxCall[0]).toContain('`idx_email`');
    });

    it('creates UNIQUE indexes', async () => {
      const diff: SchemaDiff = {
        ...emptyDiff(),
        indexesToCreate: [{
          tableName: 'users',
          index: { name: 'uq_email', columns: ['email'], isUnique: true, method: 'btree' },
        }],
      };

      await sync.createIndexes(connection, diff);

      const calls = (connection.query as ReturnType<typeof vi.fn>).mock.calls as [string][];
      const idxCall = calls.find(([sql]) => sql.includes('CREATE UNIQUE'))!;
      expect(idxCall).toBeDefined();
    });

    it('warns but does not throw on index creation failure', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      (connection.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('dup key'));

      const diff: SchemaDiff = {
        ...emptyDiff(),
        indexesToCreate: [{
          tableName: 'users',
          index: { name: 'idx_name', columns: ['name'], isUnique: false, method: 'btree' },
        }],
      };

      await expect(sync.createIndexes(connection, diff)).resolves.not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('WARN:'));
      warnSpy.mockRestore();
    });
  });
});
