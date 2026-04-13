"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const pg_schema_inspector_adapter_1 = require("../../../src/infrastructure/database/pg/pg-schema-inspector.adapter");
const mock_database_1 = require("../../helpers/mock-database");
const migration_errors_1 = require("../../../src/domain/errors/migration.errors");
(0, vitest_1.describe)('PgSchemaInspector', () => {
    let inspector;
    let conn;
    (0, vitest_1.beforeEach)(() => {
        inspector = new pg_schema_inspector_adapter_1.PgSchemaInspector();
        conn = (0, mock_database_1.createMockConnection)();
    });
    (0, vitest_1.describe)('inspect', () => {
        (0, vitest_1.it)('returns empty schema when no tables exist', async () => {
            (0, mock_database_1.mockQuerySequence)(conn, [[], [], [], [], []]);
            const schema = await inspector.inspect(conn);
            (0, vitest_1.expect)(schema.tables).toHaveLength(0);
            (0, vitest_1.expect)(schema.sequences).toHaveLength(0);
        });
        (0, vitest_1.it)('builds tables from column rows', async () => {
            const columns = [
                {
                    table_name: 'users',
                    column_name: 'id',
                    data_type: 'integer',
                    udt_name: 'int4',
                    is_nullable: 'NO',
                    column_default: null,
                    character_maximum_length: null,
                    numeric_precision: 32,
                    numeric_scale: 0,
                },
                {
                    table_name: 'users',
                    column_name: 'email',
                    data_type: 'character varying',
                    udt_name: 'varchar',
                    is_nullable: 'NO',
                    column_default: null,
                    character_maximum_length: 255,
                    numeric_precision: null,
                    numeric_scale: null,
                },
            ];
            (0, mock_database_1.mockQuerySequence)(conn, [columns, [], [], [], []]);
            const schema = await inspector.inspect(conn);
            (0, vitest_1.expect)(schema.tables).toHaveLength(1);
            (0, vitest_1.expect)(schema.tables[0].name).toBe('users');
            (0, vitest_1.expect)(schema.tables[0].columns).toHaveLength(2);
            (0, vitest_1.expect)(schema.tables[0].columns[0].name).toBe('id');
            (0, vitest_1.expect)(schema.tables[0].columns[1].name).toBe('email');
        });
        (0, vitest_1.it)('maps is_nullable correctly', async () => {
            const columns = [
                {
                    table_name: 'items',
                    column_name: 'name',
                    data_type: 'text',
                    udt_name: 'text',
                    is_nullable: 'YES',
                    column_default: null,
                    character_maximum_length: null,
                    numeric_precision: null,
                    numeric_scale: null,
                },
            ];
            (0, mock_database_1.mockQuerySequence)(conn, [columns, [], [], [], []]);
            const schema = await inspector.inspect(conn);
            (0, vitest_1.expect)(schema.tables[0].columns[0].isNullable).toBe(true);
        });
        (0, vitest_1.it)('uses udt_name for USER-DEFINED data types', async () => {
            const columns = [
                {
                    table_name: 'items',
                    column_name: 'status',
                    data_type: 'USER-DEFINED',
                    udt_name: 'my_enum',
                    is_nullable: 'NO',
                    column_default: null,
                    character_maximum_length: null,
                    numeric_precision: null,
                    numeric_scale: null,
                },
            ];
            (0, mock_database_1.mockQuerySequence)(conn, [columns, [], [], [], []]);
            const schema = await inspector.inspect(conn);
            (0, vitest_1.expect)(schema.tables[0].columns[0].dataType).toBe('my_enum');
        });
        (0, vitest_1.it)('builds primary key constraints', async () => {
            const columns = [
                {
                    table_name: 'users',
                    column_name: 'id',
                    data_type: 'integer',
                    udt_name: 'int4',
                    is_nullable: 'NO',
                    column_default: null,
                    character_maximum_length: null,
                    numeric_precision: null,
                    numeric_scale: null,
                },
            ];
            const constraints = [
                {
                    table_name: 'users',
                    constraint_name: 'pk_users',
                    constraint_type: 'PRIMARY KEY',
                    column_name: 'id',
                    foreign_table_name: null,
                    foreign_column_name: null,
                    delete_rule: null,
                    update_rule: null,
                    check_clause: null,
                },
            ];
            (0, mock_database_1.mockQuerySequence)(conn, [columns, constraints, [], [], []]);
            const schema = await inspector.inspect(conn);
            const pk = schema.tables[0].constraints.find((c) => c.name === 'pk_users');
            (0, vitest_1.expect)(pk).toBeDefined();
            (0, vitest_1.expect)(pk.type).toBe('PRIMARY KEY');
            (0, vitest_1.expect)(pk.columns).toContain('id');
        });
        (0, vitest_1.it)('builds foreign key constraints with references', async () => {
            const columns = [
                { table_name: 'orders', column_name: 'user_id', data_type: 'integer', udt_name: 'int4', is_nullable: 'NO', column_default: null, character_maximum_length: null, numeric_precision: null, numeric_scale: null },
            ];
            const constraints = [
                {
                    table_name: 'orders',
                    constraint_name: 'fk_orders_user',
                    constraint_type: 'FOREIGN KEY',
                    column_name: 'user_id',
                    foreign_table_name: 'users',
                    foreign_column_name: 'id',
                    delete_rule: 'CASCADE',
                    update_rule: 'NO ACTION',
                    check_clause: null,
                },
            ];
            (0, mock_database_1.mockQuerySequence)(conn, [columns, constraints, [], [], []]);
            const schema = await inspector.inspect(conn);
            const fk = schema.tables[0].constraints.find((c) => c.name === 'fk_orders_user');
            (0, vitest_1.expect)(fk.type).toBe('FOREIGN KEY');
            (0, vitest_1.expect)(fk.referencedTable).toBe('users');
            (0, vitest_1.expect)(fk.onDelete).toBe('CASCADE');
        });
        (0, vitest_1.it)('merges multi-column constraint rows', async () => {
            const columns = [
                { table_name: 't', column_name: 'a', data_type: 'integer', udt_name: 'int4', is_nullable: 'NO', column_default: null, character_maximum_length: null, numeric_precision: null, numeric_scale: null },
                { table_name: 't', column_name: 'b', data_type: 'integer', udt_name: 'int4', is_nullable: 'NO', column_default: null, character_maximum_length: null, numeric_precision: null, numeric_scale: null },
            ];
            const constraints = [
                { table_name: 't', constraint_name: 'pk_t', constraint_type: 'PRIMARY KEY', column_name: 'a', foreign_table_name: null, foreign_column_name: null, delete_rule: null, update_rule: null, check_clause: null },
                { table_name: 't', constraint_name: 'pk_t', constraint_type: 'PRIMARY KEY', column_name: 'b', foreign_table_name: null, foreign_column_name: null, delete_rule: null, update_rule: null, check_clause: null },
            ];
            (0, mock_database_1.mockQuerySequence)(conn, [columns, constraints, [], [], []]);
            const schema = await inspector.inspect(conn);
            const pk = schema.tables[0].constraints[0];
            (0, vitest_1.expect)(pk.columns).toEqual(['a', 'b']);
        });
        (0, vitest_1.it)('builds indexes from pg_catalog rows', async () => {
            const columns = [
                { table_name: 'users', column_name: 'email', data_type: 'text', udt_name: 'text', is_nullable: 'NO', column_default: null, character_maximum_length: null, numeric_precision: null, numeric_scale: null },
            ];
            const indexes = [
                { table_name: 'users', index_name: 'idx_users_email', column_name: 'email', is_unique: true, index_method: 'btree' },
            ];
            (0, mock_database_1.mockQuerySequence)(conn, [columns, [], indexes, [], []]);
            const schema = await inspector.inspect(conn);
            (0, vitest_1.expect)(schema.tables[0].indexes).toHaveLength(1);
            (0, vitest_1.expect)(schema.tables[0].indexes[0].name).toBe('idx_users_email');
            (0, vitest_1.expect)(schema.tables[0].indexes[0].isUnique).toBe(true);
            (0, vitest_1.expect)(schema.tables[0].indexes[0].method).toBe('btree');
        });
        (0, vitest_1.it)('builds sequences', async () => {
            const seqRows = [
                { sequence_name: 'users_id_seq', start_value: '1', minimum_value: '1', maximum_value: '9223372036854775807', increment: '1', cycle_option: 'NO' },
            ];
            // sequences query + last_value query
            (0, mock_database_1.mockQuerySequence)(conn, [[], [], [], seqRows, [], [{ last_value: 42 }]]);
            const schema = await inspector.inspect(conn);
            (0, vitest_1.expect)(schema.sequences).toHaveLength(1);
            (0, vitest_1.expect)(schema.sequences[0].name).toBe('users_id_seq');
            (0, vitest_1.expect)(schema.sequences[0].lastValue).toBe(42);
        });
        (0, vitest_1.it)('wraps unexpected errors in SchemaInspectionError', async () => {
            conn.query.mockRejectedValue(new Error('connection reset'));
            await (0, vitest_1.expect)(inspector.inspect(conn)).rejects.toThrow(migration_errors_1.SchemaInspectionError);
        });
    });
    (0, vitest_1.describe)('getTableRowEstimates', () => {
        (0, vitest_1.it)('returns a map of table name to row count', async () => {
            conn.query.mockResolvedValue([
                { relname: 'users', reltuples: 1000 },
                { relname: 'orders', reltuples: 5000 },
            ]);
            const map = await inspector.getTableRowEstimates(conn);
            (0, vitest_1.expect)(map.get('users')).toBe(1000);
            (0, vitest_1.expect)(map.get('orders')).toBe(5000);
        });
        (0, vitest_1.it)('falls back to COUNT(*) when reltuples is -1 (no stats)', async () => {
            conn.query
                .mockResolvedValueOnce([{ relname: 'new_table', reltuples: -1 }])
                .mockResolvedValueOnce([{ count: '42' }]);
            const map = await inspector.getTableRowEstimates(conn);
            (0, vitest_1.expect)(map.get('new_table')).toBe(42);
        });
        (0, vitest_1.it)('falls back to COUNT(*) when reltuples is 0 (stale stats)', async () => {
            conn.query
                .mockResolvedValueOnce([{ relname: 'empty_table', reltuples: 0 }])
                .mockResolvedValueOnce([{ count: '0' }]);
            const map = await inspector.getTableRowEstimates(conn);
            (0, vitest_1.expect)(map.get('empty_table')).toBe(0);
        });
    });
});
