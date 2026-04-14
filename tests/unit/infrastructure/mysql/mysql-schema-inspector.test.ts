import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MysqlSchemaInspector } from '../../../../src/infrastructure/database/mysql/mysql-schema-inspector.adapter';
import { createMockConnection, mockQuerySequence } from '../../../helpers/mock-database';
import { IDatabaseConnection } from '../../../../src/domain/ports/database.port';

function makeInspector() {
  return new MysqlSchemaInspector();
}

/** Shorthand for building the 4-query sequence expected by inspect(). */
function mockInspectorQueries(
  connection: IDatabaseConnection,
  dbRow: unknown[],
  columnRows: unknown[],
  constraintRows: unknown[],
  indexRows: unknown[]
) {
  mockQuerySequence(connection, [
    dbRow,        // SELECT DATABASE()
    columnRows,   // columns query (parallel)
    constraintRows, // constraints query (parallel)
    indexRows,    // indexes query (parallel)
  ]);
}

describe('MysqlSchemaInspector', () => {
  let inspector: MysqlSchemaInspector;
  let connection: IDatabaseConnection;

  beforeEach(() => {
    inspector = makeInspector();
    connection = createMockConnection();
  });

  describe('inspect()', () => {
    it('returns empty schema when there are no tables', async () => {
      mockInspectorQueries(connection, [{ db: 'testdb' }], [], [], []);
      const schema = await inspector.inspect(connection);
      expect(schema.tables).toHaveLength(0);
      expect(schema.sequences).toHaveLength(0);
      expect(schema.enums).toHaveLength(0);
    });

    it('maps column metadata correctly', async () => {
      const colRows = [
        {
          table_name: 'users',
          column_name: 'id',
          data_type: 'int',
          column_type: 'int(11)',
          is_nullable: 'NO',
          column_default: null,
          character_maximum_length: null,
          numeric_precision: 10,
          numeric_scale: 0,
          extra: 'auto_increment',
        },
        {
          table_name: 'users',
          column_name: 'email',
          data_type: 'varchar',
          column_type: 'varchar(255)',
          is_nullable: 'NO',
          column_default: null,
          character_maximum_length: 255,
          numeric_precision: null,
          numeric_scale: null,
          extra: '',
        },
        {
          table_name: 'users',
          column_name: 'is_active',
          data_type: 'tinyint',
          column_type: 'tinyint(1)',
          is_nullable: 'YES',
          column_default: '1',
          character_maximum_length: null,
          numeric_precision: 3,
          numeric_scale: 0,
          extra: '',
        },
      ];

      mockInspectorQueries(connection, [{ db: 'testdb' }], colRows, [], []);
      const schema = await inspector.inspect(connection);

      expect(schema.tables).toHaveLength(1);
      const table = schema.tables[0];
      expect(table.name).toBe('users');
      expect(table.columns).toHaveLength(3);

      const idCol = table.columns[0];
      expect(idCol.name).toBe('id');
      expect(idCol.dataType).toBe('int(11)');
      expect(idCol.isNullable).toBe(false);

      const emailCol = table.columns[1];
      expect(emailCol.name).toBe('email');
      expect(emailCol.dataType).toBe('varchar(255)');
      expect(emailCol.characterMaxLength).toBe(255);

      const activeCol = table.columns[2];
      expect(activeCol.name).toBe('is_active');
      expect(activeCol.dataType).toBe('tinyint(1)');
      expect(activeCol.isNullable).toBe(true);
      expect(activeCol.defaultValue).toBe('1');
    });

    it('builds PRIMARY KEY constraint correctly', async () => {
      const colRows = [{
        table_name: 'orders', column_name: 'id', data_type: 'int',
        column_type: 'int(11)', is_nullable: 'NO', column_default: null,
        character_maximum_length: null, numeric_precision: 10, numeric_scale: 0, extra: '',
      }];

      const constraintRows = [{
        table_name: 'orders',
        constraint_name: 'PRIMARY',
        constraint_type: 'PRIMARY KEY',
        column_name: 'id',
        referenced_table: null,
        referenced_column: null,
        on_delete: null,
        on_update: null,
      }];

      mockInspectorQueries(connection, [{ db: 'testdb' }], colRows, constraintRows, []);
      const schema = await inspector.inspect(connection);
      const pk = schema.tables[0].constraints.find((c) => c.type === 'PRIMARY KEY');
      expect(pk).toBeDefined();
      expect(pk!.columns).toEqual(['id']);
    });

    it('merges multi-column PRIMARY KEY', async () => {
      const colRows = [
        {
          table_name: 'order_items', column_name: 'order_id', data_type: 'int',
          column_type: 'int(11)', is_nullable: 'NO', column_default: null,
          character_maximum_length: null, numeric_precision: 10, numeric_scale: 0, extra: '',
        },
        {
          table_name: 'order_items', column_name: 'item_id', data_type: 'int',
          column_type: 'int(11)', is_nullable: 'NO', column_default: null,
          character_maximum_length: null, numeric_precision: 10, numeric_scale: 0, extra: '',
        },
      ];

      const constraintRows = [
        {
          table_name: 'order_items', constraint_name: 'PRIMARY', constraint_type: 'PRIMARY KEY',
          column_name: 'order_id', referenced_table: null, referenced_column: null,
          on_delete: null, on_update: null,
        },
        {
          table_name: 'order_items', constraint_name: 'PRIMARY', constraint_type: 'PRIMARY KEY',
          column_name: 'item_id', referenced_table: null, referenced_column: null,
          on_delete: null, on_update: null,
        },
      ];

      mockInspectorQueries(connection, [{ db: 'testdb' }], colRows, constraintRows, []);
      const schema = await inspector.inspect(connection);
      const pk = schema.tables[0].constraints[0];
      expect(pk.columns).toEqual(['order_id', 'item_id']);
    });

    it('builds FOREIGN KEY constraint with references', async () => {
      const colRows = [{
        table_name: 'orders', column_name: 'user_id', data_type: 'int',
        column_type: 'int(11)', is_nullable: 'NO', column_default: null,
        character_maximum_length: null, numeric_precision: 10, numeric_scale: 0, extra: '',
      }];

      const constraintRows = [{
        table_name: 'orders',
        constraint_name: 'fk_orders_user',
        constraint_type: 'FOREIGN KEY',
        column_name: 'user_id',
        referenced_table: 'users',
        referenced_column: 'id',
        on_delete: 'CASCADE',
        on_update: 'NO ACTION',
      }];

      mockInspectorQueries(connection, [{ db: 'testdb' }], colRows, constraintRows, []);
      const schema = await inspector.inspect(connection);
      const fk = schema.tables[0].constraints[0];
      expect(fk.type).toBe('FOREIGN KEY');
      expect(fk.referencedTable).toBe('users');
      expect(fk.referencedColumns).toEqual(['id']);
      expect(fk.onDelete).toBe('CASCADE');
    });

    it('builds indexes correctly, excluding unique index duplicates', async () => {
      const colRows = [{
        table_name: 'products', column_name: 'sku', data_type: 'varchar',
        column_type: 'varchar(100)', is_nullable: 'NO', column_default: null,
        character_maximum_length: 100, numeric_precision: null, numeric_scale: null, extra: '',
      }];

      const indexRows = [
        {
          table_name: 'products',
          index_name: 'idx_sku',
          column_name: 'sku',
          non_unique: 1,
          seq_in_index: 1,
        },
        {
          table_name: 'products',
          index_name: 'uq_sku',
          column_name: 'sku',
          non_unique: 0,
          seq_in_index: 1,
        },
      ];

      mockInspectorQueries(connection, [{ db: 'testdb' }], colRows, [], indexRows);
      const schema = await inspector.inspect(connection);
      const indexes = schema.tables[0].indexes;
      expect(indexes).toHaveLength(2);

      const nonUniq = indexes.find((i) => i.name === 'idx_sku');
      expect(nonUniq!.isUnique).toBe(false);

      const uniq = indexes.find((i) => i.name === 'uq_sku');
      expect(uniq!.isUnique).toBe(true);
    });

    it('uses schemaName argument when provided', async () => {
      mockQuerySequence(connection, [[], [], []]);
      await inspector.inspect(connection, 'myschema');
      // Should not call SELECT DATABASE() — queries should use 'myschema' directly
      // We verify there's no extra query beyond the 3 parallel ones
      expect((connection.query as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
    });
  });

  describe('getTableRowEstimates()', () => {
    it('returns estimates from information_schema', async () => {
      mockQuerySequence(connection, [
        [{ db: 'testdb' }],
        [
          { table_name: 'users', table_rows: 1000 },
          { table_name: 'orders', table_rows: 5000 },
        ],
      ]);

      const estimates = await inspector.getTableRowEstimates(connection);
      expect(estimates.get('users')).toBe(1000);
      expect(estimates.get('orders')).toBe(5000);
    });

    it('falls back to COUNT(*) when table_rows is 0', async () => {
      mockQuerySequence(connection, [
        [{ db: 'testdb' }],
        [{ table_name: 'small_table', table_rows: 0 }],
        [{ count: '42' }], // COUNT(*) result
      ]);

      const estimates = await inspector.getTableRowEstimates(connection);
      expect(estimates.get('small_table')).toBe(42);
    });
  });
});
