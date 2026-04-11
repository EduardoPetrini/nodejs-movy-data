import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PgSchemaSynchronizer } from '../../../src/infrastructure/database/pg/pg-schema-synchronizer.adapter';
import { createMockConnection } from '../../helpers/mock-database';
import { DatabaseSchema, TableSchema } from '../../../src/domain/types/schema.types';
import { SchemaSyncError } from '../../../src/domain/errors/migration.errors';

function emptySchema(): DatabaseSchema {
  return { tables: [], sequences: [], enums: [] };
}

function makeTable(name: string, overrides?: Partial<TableSchema>): TableSchema {
  return {
    name,
    columns: [{ name: 'id', dataType: 'integer', isNullable: false, defaultValue: null, characterMaxLength: null, numericPrecision: 32, numericScale: 0 }],
    constraints: [],
    indexes: [],
    ...overrides,
  };
}

describe('PgSchemaSynchronizer', () => {
  let sync: PgSchemaSynchronizer;

  beforeEach(() => {
    sync = new PgSchemaSynchronizer();
  });

  describe('diff', () => {
    it('returns empty diff for identical schemas', () => {
      const schema: DatabaseSchema = { tables: [makeTable('users')], sequences: [], enums: [] };
      const diff = sync.diff(schema, schema);
      expect(diff.tablesToCreate).toHaveLength(0);
      expect(diff.tablesToDrop).toHaveLength(0);
      expect(diff.columnsToAdd).toHaveLength(0);
    });

    it('identifies tables to create', () => {
      const source: DatabaseSchema = { tables: [makeTable('users')], sequences: [], enums: [] };
      const diff = sync.diff(source, emptySchema());
      expect(diff.tablesToCreate).toHaveLength(1);
      expect(diff.tablesToCreate[0].name).toBe('users');
    });

    it('identifies tables to drop', () => {
      const target: DatabaseSchema = { tables: [makeTable('old_table')], sequences: [], enums: [] };
      const diff = sync.diff(emptySchema(), target);
      expect(diff.tablesToDrop).toContain('old_table');
    });

    it('identifies columns to add', () => {
      const source: DatabaseSchema = {
        tables: [makeTable('users', {
          columns: [
            { name: 'id', dataType: 'integer', isNullable: false, defaultValue: null, characterMaxLength: null, numericPrecision: null, numericScale: null },
            { name: 'email', dataType: 'text', isNullable: false, defaultValue: null, characterMaxLength: null, numericPrecision: null, numericScale: null },
          ],
        })],
        sequences: [],
        enums: [],
      };
      const target: DatabaseSchema = {
        tables: [makeTable('users', {
          columns: [
            { name: 'id', dataType: 'integer', isNullable: false, defaultValue: null, characterMaxLength: null, numericPrecision: null, numericScale: null },
          ],
        })],
        sequences: [],
        enums: [],
      };
      const diff = sync.diff(source, target);
      expect(diff.columnsToAdd).toHaveLength(1);
      expect(diff.columnsToAdd[0].column.name).toBe('email');
    });

    it('identifies columns to drop', () => {
      const source: DatabaseSchema = {
        tables: [makeTable('users', { columns: [{ name: 'id', dataType: 'integer', isNullable: false, defaultValue: null, characterMaxLength: null, numericPrecision: null, numericScale: null }] })],
        sequences: [],
        enums: [],
      };
      const target: DatabaseSchema = {
        tables: [makeTable('users', {
          columns: [
            { name: 'id', dataType: 'integer', isNullable: false, defaultValue: null, characterMaxLength: null, numericPrecision: null, numericScale: null },
            { name: 'obsolete', dataType: 'text', isNullable: true, defaultValue: null, characterMaxLength: null, numericPrecision: null, numericScale: null },
          ],
        })],
        sequences: [],
        enums: [],
      };
      const diff = sync.diff(source, target);
      expect(diff.columnsToDrop).toHaveLength(1);
      expect(diff.columnsToDrop[0].columnName).toBe('obsolete');
    });

    it('identifies type changes as columnsToAlter', () => {
      const source: DatabaseSchema = {
        tables: [makeTable('users', { columns: [{ name: 'score', dataType: 'bigint', isNullable: true, defaultValue: null, characterMaxLength: null, numericPrecision: null, numericScale: null }] })],
        sequences: [],
        enums: [],
      };
      const target: DatabaseSchema = {
        tables: [makeTable('users', { columns: [{ name: 'score', dataType: 'integer', isNullable: true, defaultValue: null, characterMaxLength: null, numericPrecision: null, numericScale: null }] })],
        sequences: [],
        enums: [],
      };
      const diff = sync.diff(source, target);
      expect(diff.columnsToAlter).toHaveLength(1);
      expect(diff.columnsToAlter[0].diff.sourceType).toBe('bigint');
    });

    it('identifies sequences to create', () => {
      const source: DatabaseSchema = {
        tables: [],
        sequences: [{ name: 'users_id_seq', startValue: 1, minValue: 1, maxValue: 9999, incrementBy: 1, cycleOption: false, lastValue: null }],
        enums: [],
      };
      const diff = sync.diff(source, emptySchema());
      expect(diff.sequencesToCreate).toHaveLength(1);
    });
  });

  describe('apply', () => {
    it('executes no query when diff is empty', async () => {
      const conn = createMockConnection();
      await sync.apply(conn, {
        tablesToCreate: [], tablesToDrop: [], columnsToAdd: [], columnsToDrop: [],
        columnsToAlter: [], constraintsToAdd: [], constraintsToDrop: [],
        indexesToCreate: [], indexesToDrop: [], sequencesToCreate: [], enumsToCreate: [],
      });
      expect(conn.query).not.toHaveBeenCalled();
      expect(conn.getClient).not.toHaveBeenCalled();
    });

    it('wraps DDL in a transaction via dedicated client', async () => {
      const mockClient = { query: vi.fn(), release: vi.fn() };
      const conn = createMockConnection();
      (conn.getClient as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient);

      const diff = sync.diff({ tables: [makeTable('users')], sequences: [], enums: [] }, emptySchema());
      await sync.apply(conn, diff);

      const calls = (mockClient.query as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
      expect(calls[0]).toBe('BEGIN');
      expect(calls[calls.length - 1]).toBe('COMMIT');
      expect(calls.some((c) => /CREATE TABLE/.test(c))).toBe(true);
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('creates enum types before tables', async () => {
      const mockClient = { query: vi.fn(), release: vi.fn() };
      const conn = createMockConnection();
      (conn.getClient as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient);

      const table = makeTable('items', {
        columns: [{ name: 'status', dataType: 'myenum', isNullable: false, defaultValue: null, characterMaxLength: null, numericPrecision: null, numericScale: null }],
      });
      const source = { tables: [table], sequences: [], enums: [{ name: 'myenum', values: ['a', 'b'] }] };
      const diff = sync.diff(source, emptySchema());
      await sync.apply(conn, diff);

      const calls = (mockClient.query as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
      const beginIdx = calls.findIndex((c) => c === 'BEGIN');
      const enumIdx = calls.findIndex((c) => /CREATE TYPE/.test(c));
      const tableIdx = calls.findIndex((c) => /CREATE TABLE/.test(c));
      expect(beginIdx).toBeLessThan(enumIdx);
      expect(enumIdx).toBeLessThan(tableIdx);
    });

    it('rolls back and throws SchemaSyncError on DDL failure', async () => {
      const mockClient = {
        query: vi.fn()
          .mockResolvedValueOnce({}) // BEGIN
          .mockRejectedValueOnce(new Error('syntax error')), // first DDL fails
        release: vi.fn(),
      };
      const conn = createMockConnection();
      (conn.getClient as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient);

      const diff = sync.diff({ tables: [makeTable('users')], sequences: [], enums: [] }, emptySchema());
      await expect(sync.apply(conn, diff)).rejects.toThrow(SchemaSyncError);
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('disableTriggers / enableTriggers', () => {
    it('issues DISABLE TRIGGER ALL for each table', async () => {
      const conn = createMockConnection();
      await sync.disableTriggers(conn, ['users', 'orders']);
      expect(conn.query).toHaveBeenCalledTimes(2);
      expect((conn.query as any).mock.calls[0][0]).toMatch(/DISABLE TRIGGER ALL/);
    });

    it('issues ENABLE TRIGGER ALL for each table', async () => {
      const conn = createMockConnection();
      await sync.enableTriggers(conn, ['users']);
      expect((conn.query as any).mock.calls[0][0]).toMatch(/ENABLE TRIGGER ALL/);
    });
  });

  describe('createIndexes', () => {
    it('creates a unique btree index', async () => {
      const conn = createMockConnection();
      await sync.createIndexes(conn, {
        tablesToCreate: [], tablesToDrop: [], columnsToAdd: [], columnsToDrop: [],
        columnsToAlter: [], constraintsToAdd: [], constraintsToDrop: [],
        indexesToCreate: [{ tableName: 'users', index: { name: 'idx_email', columns: ['email'], isUnique: true, method: 'btree' } }],
        indexesToDrop: [], sequencesToCreate: [], enumsToCreate: [],
      });
      const sql = (conn.query as any).mock.calls[0][0] as string;
      expect(sql).toMatch(/CREATE UNIQUE INDEX/);
      expect(sql).toMatch(/btree/);
    });

    it('does not throw on index creation failure, emits warning', async () => {
      const conn = createMockConnection();
      (conn.query as any).mockRejectedValue(new Error('already exists'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await expect(
        sync.createIndexes(conn, {
          tablesToCreate: [], tablesToDrop: [], columnsToAdd: [], columnsToDrop: [],
          columnsToAlter: [], constraintsToAdd: [], constraintsToDrop: [],
          indexesToCreate: [{ tableName: 'users', index: { name: 'idx_x', columns: ['x'], isUnique: false, method: 'btree' } }],
          indexesToDrop: [], sequencesToCreate: [], enumsToCreate: [],
        })
      ).resolves.not.toThrow();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('resetSequences', () => {
    it('queries last_value from source and calls setval on dest', async () => {
      const source = createMockConnection();
      const dest = createMockConnection();
      (source.query as any).mockResolvedValue([{ last_value: 99 }]);
      await sync.resetSequences(source, dest, [
        { name: 'users_id_seq', startValue: 1, minValue: 1, maxValue: 9999, incrementBy: 1, cycleOption: false, lastValue: null },
      ]);
      expect(dest.query).toHaveBeenCalledWith(expect.stringContaining('setval'), ['users_id_seq', 99]);
    });

    it('emits warning on failure but does not throw', async () => {
      const source = createMockConnection();
      const dest = createMockConnection();
      (source.query as any).mockRejectedValue(new Error('no such sequence'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await expect(
        sync.resetSequences(source, dest, [
          { name: 'missing_seq', startValue: 1, minValue: 1, maxValue: 9999, incrementBy: 1, cycleOption: false, lastValue: null },
        ])
      ).resolves.not.toThrow();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });
});
