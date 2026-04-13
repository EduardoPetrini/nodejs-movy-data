"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const pg_schema_synchronizer_adapter_1 = require("../../../src/infrastructure/database/pg/pg-schema-synchronizer.adapter");
const mock_database_1 = require("../../helpers/mock-database");
const migration_errors_1 = require("../../../src/domain/errors/migration.errors");
function emptySchema() {
    return { tables: [], sequences: [], enums: [] };
}
function makeTable(name, overrides) {
    return {
        name,
        columns: [{ name: 'id', dataType: 'integer', isNullable: false, defaultValue: null, characterMaxLength: null, numericPrecision: 32, numericScale: 0 }],
        constraints: [],
        indexes: [],
        ...overrides,
    };
}
(0, vitest_1.describe)('PgSchemaSynchronizer', () => {
    let sync;
    (0, vitest_1.beforeEach)(() => {
        sync = new pg_schema_synchronizer_adapter_1.PgSchemaSynchronizer();
    });
    (0, vitest_1.describe)('diff', () => {
        (0, vitest_1.it)('returns empty diff for identical schemas', () => {
            const schema = { tables: [makeTable('users')], sequences: [], enums: [] };
            const diff = sync.diff(schema, schema);
            (0, vitest_1.expect)(diff.tablesToCreate).toHaveLength(0);
            (0, vitest_1.expect)(diff.tablesToDrop).toHaveLength(0);
            (0, vitest_1.expect)(diff.columnsToAdd).toHaveLength(0);
        });
        (0, vitest_1.it)('identifies tables to create', () => {
            const source = { tables: [makeTable('users')], sequences: [], enums: [] };
            const diff = sync.diff(source, emptySchema());
            (0, vitest_1.expect)(diff.tablesToCreate).toHaveLength(1);
            (0, vitest_1.expect)(diff.tablesToCreate[0].name).toBe('users');
        });
        (0, vitest_1.it)('identifies tables to drop', () => {
            const target = { tables: [makeTable('old_table')], sequences: [], enums: [] };
            const diff = sync.diff(emptySchema(), target);
            (0, vitest_1.expect)(diff.tablesToDrop).toContain('old_table');
        });
        (0, vitest_1.it)('identifies columns to add', () => {
            const source = {
                tables: [makeTable('users', {
                        columns: [
                            { name: 'id', dataType: 'integer', isNullable: false, defaultValue: null, characterMaxLength: null, numericPrecision: null, numericScale: null },
                            { name: 'email', dataType: 'text', isNullable: false, defaultValue: null, characterMaxLength: null, numericPrecision: null, numericScale: null },
                        ],
                    })],
                sequences: [],
                enums: [],
            };
            const target = {
                tables: [makeTable('users', {
                        columns: [
                            { name: 'id', dataType: 'integer', isNullable: false, defaultValue: null, characterMaxLength: null, numericPrecision: null, numericScale: null },
                        ],
                    })],
                sequences: [],
                enums: [],
            };
            const diff = sync.diff(source, target);
            (0, vitest_1.expect)(diff.columnsToAdd).toHaveLength(1);
            (0, vitest_1.expect)(diff.columnsToAdd[0].column.name).toBe('email');
        });
        (0, vitest_1.it)('identifies columns to drop', () => {
            const source = {
                tables: [makeTable('users', { columns: [{ name: 'id', dataType: 'integer', isNullable: false, defaultValue: null, characterMaxLength: null, numericPrecision: null, numericScale: null }] })],
                sequences: [],
                enums: [],
            };
            const target = {
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
            (0, vitest_1.expect)(diff.columnsToDrop).toHaveLength(1);
            (0, vitest_1.expect)(diff.columnsToDrop[0].columnName).toBe('obsolete');
        });
        (0, vitest_1.it)('identifies type changes as columnsToAlter', () => {
            const source = {
                tables: [makeTable('users', { columns: [{ name: 'score', dataType: 'bigint', isNullable: true, defaultValue: null, characterMaxLength: null, numericPrecision: null, numericScale: null }] })],
                sequences: [],
                enums: [],
            };
            const target = {
                tables: [makeTable('users', { columns: [{ name: 'score', dataType: 'integer', isNullable: true, defaultValue: null, characterMaxLength: null, numericPrecision: null, numericScale: null }] })],
                sequences: [],
                enums: [],
            };
            const diff = sync.diff(source, target);
            (0, vitest_1.expect)(diff.columnsToAlter).toHaveLength(1);
            (0, vitest_1.expect)(diff.columnsToAlter[0].diff.sourceType).toBe('bigint');
        });
        (0, vitest_1.it)('identifies sequences to create', () => {
            const source = {
                tables: [],
                sequences: [{ name: 'users_id_seq', startValue: 1, minValue: 1, maxValue: 9999, incrementBy: 1, cycleOption: false, lastValue: null }],
                enums: [],
            };
            const diff = sync.diff(source, emptySchema());
            (0, vitest_1.expect)(diff.sequencesToCreate).toHaveLength(1);
        });
    });
    (0, vitest_1.describe)('apply', () => {
        (0, vitest_1.it)('executes no query when diff is empty', async () => {
            const conn = (0, mock_database_1.createMockConnection)();
            await sync.apply(conn, {
                tablesToCreate: [], tablesToDrop: [], columnsToAdd: [], columnsToDrop: [],
                columnsToAlter: [], constraintsToAdd: [], constraintsToDrop: [],
                indexesToCreate: [], indexesToDrop: [], sequencesToCreate: [], enumsToCreate: [],
            });
            (0, vitest_1.expect)(conn.query).not.toHaveBeenCalled();
            (0, vitest_1.expect)(conn.getClient).not.toHaveBeenCalled();
        });
        (0, vitest_1.it)('wraps DDL in a transaction via dedicated client', async () => {
            const mockClient = { query: vitest_1.vi.fn(), release: vitest_1.vi.fn() };
            const conn = (0, mock_database_1.createMockConnection)();
            conn.getClient.mockResolvedValue(mockClient);
            const diff = sync.diff({ tables: [makeTable('users')], sequences: [], enums: [] }, emptySchema());
            await sync.apply(conn, diff);
            const calls = mockClient.query.mock.calls.map((c) => c[0]);
            (0, vitest_1.expect)(calls[0]).toBe('BEGIN');
            (0, vitest_1.expect)(calls[calls.length - 1]).toBe('COMMIT');
            (0, vitest_1.expect)(calls.some((c) => /CREATE TABLE/.test(c))).toBe(true);
            (0, vitest_1.expect)(mockClient.release).toHaveBeenCalled();
        });
        (0, vitest_1.it)('creates enum types before tables', async () => {
            const mockClient = { query: vitest_1.vi.fn(), release: vitest_1.vi.fn() };
            const conn = (0, mock_database_1.createMockConnection)();
            conn.getClient.mockResolvedValue(mockClient);
            const table = makeTable('items', {
                columns: [{ name: 'status', dataType: 'myenum', isNullable: false, defaultValue: null, characterMaxLength: null, numericPrecision: null, numericScale: null }],
            });
            const source = { tables: [table], sequences: [], enums: [{ name: 'myenum', values: ['a', 'b'] }] };
            const diff = sync.diff(source, emptySchema());
            await sync.apply(conn, diff);
            const calls = mockClient.query.mock.calls.map((c) => c[0]);
            const beginIdx = calls.findIndex((c) => c === 'BEGIN');
            const enumIdx = calls.findIndex((c) => /CREATE TYPE/.test(c));
            const tableIdx = calls.findIndex((c) => /CREATE TABLE/.test(c));
            (0, vitest_1.expect)(beginIdx).toBeLessThan(enumIdx);
            (0, vitest_1.expect)(enumIdx).toBeLessThan(tableIdx);
        });
        (0, vitest_1.it)('rolls back and throws SchemaSyncError on DDL failure', async () => {
            const mockClient = {
                query: vitest_1.vi.fn()
                    .mockResolvedValueOnce({}) // BEGIN
                    .mockRejectedValueOnce(new Error('syntax error')), // first DDL fails
                release: vitest_1.vi.fn(),
            };
            const conn = (0, mock_database_1.createMockConnection)();
            conn.getClient.mockResolvedValue(mockClient);
            const diff = sync.diff({ tables: [makeTable('users')], sequences: [], enums: [] }, emptySchema());
            await (0, vitest_1.expect)(sync.apply(conn, diff)).rejects.toThrow(migration_errors_1.SchemaSyncError);
            (0, vitest_1.expect)(mockClient.release).toHaveBeenCalled();
        });
    });
    (0, vitest_1.describe)('disableTriggers / enableTriggers', () => {
        (0, vitest_1.it)('issues DISABLE TRIGGER ALL for each table', async () => {
            const conn = (0, mock_database_1.createMockConnection)();
            await sync.disableTriggers(conn, ['users', 'orders']);
            (0, vitest_1.expect)(conn.query).toHaveBeenCalledTimes(2);
            (0, vitest_1.expect)(conn.query.mock.calls[0][0]).toMatch(/DISABLE TRIGGER ALL/);
        });
        (0, vitest_1.it)('issues ENABLE TRIGGER ALL for each table', async () => {
            const conn = (0, mock_database_1.createMockConnection)();
            await sync.enableTriggers(conn, ['users']);
            (0, vitest_1.expect)(conn.query.mock.calls[0][0]).toMatch(/ENABLE TRIGGER ALL/);
        });
    });
    (0, vitest_1.describe)('createIndexes', () => {
        (0, vitest_1.it)('creates a unique btree index', async () => {
            const conn = (0, mock_database_1.createMockConnection)();
            await sync.createIndexes(conn, {
                tablesToCreate: [], tablesToDrop: [], columnsToAdd: [], columnsToDrop: [],
                columnsToAlter: [], constraintsToAdd: [], constraintsToDrop: [],
                indexesToCreate: [{ tableName: 'users', index: { name: 'idx_email', columns: ['email'], isUnique: true, method: 'btree' } }],
                indexesToDrop: [], sequencesToCreate: [], enumsToCreate: [],
            });
            const sql = conn.query.mock.calls[0][0];
            (0, vitest_1.expect)(sql).toMatch(/CREATE UNIQUE INDEX/);
            (0, vitest_1.expect)(sql).toMatch(/btree/);
        });
        (0, vitest_1.it)('does not throw on index creation failure, emits warning', async () => {
            const conn = (0, mock_database_1.createMockConnection)();
            conn.query.mockRejectedValue(new Error('already exists'));
            const warnSpy = vitest_1.vi.spyOn(console, 'warn').mockImplementation(() => { });
            await (0, vitest_1.expect)(sync.createIndexes(conn, {
                tablesToCreate: [], tablesToDrop: [], columnsToAdd: [], columnsToDrop: [],
                columnsToAlter: [], constraintsToAdd: [], constraintsToDrop: [],
                indexesToCreate: [{ tableName: 'users', index: { name: 'idx_x', columns: ['x'], isUnique: false, method: 'btree' } }],
                indexesToDrop: [], sequencesToCreate: [], enumsToCreate: [],
            })).resolves.not.toThrow();
            (0, vitest_1.expect)(warnSpy).toHaveBeenCalled();
            warnSpy.mockRestore();
        });
    });
    (0, vitest_1.describe)('resetSequences', () => {
        (0, vitest_1.it)('queries last_value from source and calls setval on dest', async () => {
            const source = (0, mock_database_1.createMockConnection)();
            const dest = (0, mock_database_1.createMockConnection)();
            source.query.mockResolvedValue([{ last_value: 99 }]);
            await sync.resetSequences(source, dest, [
                { name: 'users_id_seq', startValue: 1, minValue: 1, maxValue: 9999, incrementBy: 1, cycleOption: false, lastValue: null },
            ]);
            (0, vitest_1.expect)(dest.query).toHaveBeenCalledWith(vitest_1.expect.stringContaining('setval'), ['users_id_seq', 99]);
        });
        (0, vitest_1.it)('emits warning on failure but does not throw', async () => {
            const source = (0, mock_database_1.createMockConnection)();
            const dest = (0, mock_database_1.createMockConnection)();
            source.query.mockRejectedValue(new Error('no such sequence'));
            const warnSpy = vitest_1.vi.spyOn(console, 'warn').mockImplementation(() => { });
            await (0, vitest_1.expect)(sync.resetSequences(source, dest, [
                { name: 'missing_seq', startValue: 1, minValue: 1, maxValue: 9999, incrementBy: 1, cycleOption: false, lastValue: null },
            ])).resolves.not.toThrow();
            (0, vitest_1.expect)(warnSpy).toHaveBeenCalled();
            warnSpy.mockRestore();
        });
    });
});
