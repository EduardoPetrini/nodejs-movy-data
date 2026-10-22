import { describe, it, expect, beforeEach } from 'vitest';
import { MssqlSchemaInspector } from '../../../../src/infrastructure/database/mssql/mssql-schema-inspector.adapter';
import { createMockConnection, mockQuerySequence } from '../../../helpers/mock-database';
import { IDatabaseConnection } from '../../../../src/domain/ports/database.port';

function makeInspector() {
  return new MssqlSchemaInspector();
}

function mockInspectorQueries(
  connection: IDatabaseConnection,
  columnRows: unknown[],
  constraintRows: unknown[],
  indexRows: unknown[]
) {
  mockQuerySequence(connection, [columnRows, constraintRows, indexRows]);
}

const baseColRow = {
  table_name: 'users',
  column_name: 'id',
  data_type: 'int',
  is_nullable: 'NO',
  column_default: null,
  character_maximum_length: null,
  numeric_precision: 10,
  numeric_scale: 0,
  is_identity: 1,
};

describe('MssqlSchemaInspector', () => {
  let inspector: MssqlSchemaInspector;
  let connection: IDatabaseConnection;

  beforeEach(() => {
    inspector = makeInspector();
    connection = createMockConnection();
  });

  describe('inspect()', () => {
    it('returns empty schema when there are no tables', async () => {
      mockInspectorQueries(connection, [], [], []);
      const schema = await inspector.inspect(connection);
      expect(schema.tables).toHaveLength(0);
      expect(schema.sequences).toHaveLength(0);
      expect(schema.enums).toHaveLength(0);
    });

    it('maps column metadata correctly including identity flag', async () => {
      const colRows = [
        {
          table_name: 'users',
          column_name: 'id',
          data_type: 'int',
          is_nullable: 'NO',
          column_default: null,
          character_maximum_length: null,
          numeric_precision: 10,
          numeric_scale: 0,
          is_identity: 1,
        },
        {
          table_name: 'users',
          column_name: 'email',
          data_type: 'nvarchar',
          is_nullable: 'NO',
          column_default: null,
          character_maximum_length: 255,
          numeric_precision: null,
          numeric_scale: null,
          is_identity: 0,
        },
        {
          table_name: 'users',
          column_name: 'score',
          data_type: 'decimal',
          is_nullable: 'YES',
          column_default: '((0.00))',
          character_maximum_length: null,
          numeric_precision: 10,
          numeric_scale: 2,
          is_identity: 0,
        },
      ];

      mockInspectorQueries(connection, colRows, [], []);
      const schema = await inspector.inspect(connection);

      expect(schema.tables).toHaveLength(1);
      const table = schema.tables[0];
      expect(table.name).toBe('users');
      expect(table.columns).toHaveLength(3);

      const idCol = table.columns[0];
      expect(idCol.name).toBe('id');
      expect(idCol.dataType).toBe('int');
      expect(idCol.isNullable).toBe(false);
      expect(idCol.autoIncrement).toBe(true);

      const emailCol = table.columns[1];
      expect(emailCol.name).toBe('email');
      expect(emailCol.dataType).toBe('nvarchar(255)');
      expect(emailCol.characterMaxLength).toBe(255);
      expect(emailCol.autoIncrement).toBe(false);

      const scoreCol = table.columns[2];
      expect(scoreCol.name).toBe('score');
      expect(scoreCol.dataType).toBe('decimal(10,2)');
      expect(scoreCol.isNullable).toBe(true);
      expect(scoreCol.defaultValue).toBe('((0.00))');
    });

    it('maps nvarchar(max) when character_maximum_length is -1', async () => {
      const colRows = [{
        table_name: 't',
        column_name: 'body',
        data_type: 'nvarchar',
        is_nullable: 'YES',
        column_default: null,
        character_maximum_length: -1,
        numeric_precision: null,
        numeric_scale: null,
        is_identity: 0,
      }];

      mockInspectorQueries(connection, colRows, [], []);
      const schema = await inspector.inspect(connection);
      expect(schema.tables[0].columns[0].dataType).toBe('nvarchar(max)');
    });

    it('builds PRIMARY KEY constraint correctly', async () => {
      const constraintRows = [{
        table_name: 'orders',
        constraint_name: 'PK_orders',
        constraint_type: 'PRIMARY KEY',
        column_name: 'id',
        referenced_table: null,
        referenced_column: null,
        on_delete: null,
        on_update: null,
      }];

      mockInspectorQueries(connection, [{ ...baseColRow, table_name: 'orders' }], constraintRows, []);
      const schema = await inspector.inspect(connection);
      const pk = schema.tables[0].constraints.find((c) => c.type === 'PRIMARY KEY');
      expect(pk).toBeDefined();
      expect(pk!.name).toBe('PK_orders');
      expect(pk!.columns).toEqual(['id']);
    });

    it('builds FOREIGN KEY constraint with references', async () => {
      const colRows = [
        { ...baseColRow, table_name: 'orders', column_name: 'user_id', is_identity: 0 },
      ];
      const constraintRows = [{
        table_name: 'orders',
        constraint_name: 'FK_orders_user',
        constraint_type: 'FOREIGN KEY',
        column_name: 'user_id',
        referenced_table: 'users',
        referenced_column: 'id',
        on_delete: 'CASCADE',
        on_update: 'NO ACTION',
      }];

      mockInspectorQueries(connection, colRows, constraintRows, []);
      const schema = await inspector.inspect(connection);
      const fk = schema.tables[0].constraints[0];
      expect(fk.type).toBe('FOREIGN KEY');
      expect(fk.referencedTable).toBe('users');
      expect(fk.referencedColumns).toEqual(['id']);
      expect(fk.onDelete).toBe('CASCADE');
    });

    it('builds indexes correctly, excluding constraint-backed indexes', async () => {
      const colRows = [{ ...baseColRow, table_name: 'products' }];
      const constraintRows = [{
        table_name: 'products',
        constraint_name: 'UQ_products_sku',
        constraint_type: 'UNIQUE',
        column_name: 'sku',
        referenced_table: null,
        referenced_column: null,
        on_delete: null,
        on_update: null,
      }];
      const indexRows = [
        {
          table_name: 'products',
          index_name: 'IX_products_name',
          column_name: 'name',
          is_unique: false,
          seq_in_index: 1,
          index_type: 'NONCLUSTERED',
        },
        {
          table_name: 'products',
          index_name: 'UQ_products_sku',
          column_name: 'sku',
          is_unique: true,
          seq_in_index: 1,
          index_type: 'NONCLUSTERED',
        },
      ];

      mockInspectorQueries(connection, colRows, constraintRows, indexRows);
      const schema = await inspector.inspect(connection);
      const { indexes, constraints } = schema.tables[0];

      expect(constraints).toHaveLength(1);
      expect(constraints[0].name).toBe('UQ_products_sku');
      expect(indexes).toHaveLength(1);
      expect(indexes[0].name).toBe('IX_products_name');
      expect(indexes[0].isUnique).toBe(false);
    });

    it('uses dbo as default schema when schemaName is not provided', async () => {
      mockInspectorQueries(connection, [], [], []);
      await inspector.inspect(connection);
      // Verify query was called with 'dbo' as first param
      const calls = (connection.query as ReturnType<typeof import('vitest').vi.fn>).mock.calls;
      expect(calls[0][1]).toEqual(['dbo']);
    });

    it('uses provided schemaName directly without extra query', async () => {
      mockInspectorQueries(connection, [], [], []);
      await inspector.inspect(connection, 'myschema');
      const calls = (connection.query as ReturnType<typeof import('vitest').vi.fn>).mock.calls;
      expect(calls[0][1]).toEqual(['myschema']);
    });
  });

  describe('getTableRowEstimates()', () => {
    it('returns estimates from sys.partitions', async () => {
      (connection.query as ReturnType<typeof import('vitest').vi.fn>).mockResolvedValueOnce([
        { table_name: 'users', row_count: 1000 },
        { table_name: 'orders', row_count: 5000 },
      ]);

      const estimates = await inspector.getTableRowEstimates(connection);
      expect(estimates.get('users')).toBe(1000);
      expect(estimates.get('orders')).toBe(5000);
    });

    it('returns 0 for tables with null row_count', async () => {
      (connection.query as ReturnType<typeof import('vitest').vi.fn>).mockResolvedValueOnce([
        { table_name: 'empty_table', row_count: null },
      ]);

      const estimates = await inspector.getTableRowEstimates(connection);
      expect(estimates.get('empty_table')).toBe(0);
    });
  });
});
