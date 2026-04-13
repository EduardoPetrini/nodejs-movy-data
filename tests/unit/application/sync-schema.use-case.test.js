"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const sync_schema_use_case_1 = require("../../../src/application/use-cases/sync-schema.use-case");
const mock_database_1 = require("../../helpers/mock-database");
const connection_types_1 = require("../../../src/domain/types/connection.types");
function emptyDiff() {
    return {
        tablesToCreate: [], tablesToDrop: [], columnsToAdd: [], columnsToDrop: [],
        columnsToAlter: [], constraintsToAdd: [], constraintsToDrop: [],
        indexesToCreate: [], indexesToDrop: [], sequencesToCreate: [],
    };
}
function makeLogger() {
    return { info: vitest_1.vi.fn(), warn: vitest_1.vi.fn(), error: vitest_1.vi.fn(), debug: vitest_1.vi.fn() };
}
(0, vitest_1.describe)('SyncSchemaUseCase', () => {
    let synchronizer;
    let translator;
    let logger;
    (0, vitest_1.beforeEach)(() => {
        synchronizer = {
            diff: vitest_1.vi.fn(),
            apply: vitest_1.vi.fn().mockResolvedValue(undefined),
            disableTriggers: vitest_1.vi.fn(),
            enableTriggers: vitest_1.vi.fn(),
            createIndexes: vitest_1.vi.fn(),
            resetSequences: vitest_1.vi.fn(),
        };
        translator = {
            translateColumnType: vitest_1.vi.fn((t) => t),
            translateDefaultValue: vitest_1.vi.fn((d) => d),
            translateConstraint: vitest_1.vi.fn((c) => c),
        };
        logger = makeLogger();
    });
    (0, vitest_1.it)('calls synchronizer.apply with the translated diff', async () => {
        const conn = (0, mock_database_1.createMockConnection)();
        const diff = emptyDiff();
        const useCase = new sync_schema_use_case_1.SyncSchemaUseCase(synchronizer, translator, connection_types_1.DatabaseType.POSTGRES, connection_types_1.DatabaseType.POSTGRES, logger);
        await useCase.execute(conn, diff);
        (0, vitest_1.expect)(synchronizer.apply).toHaveBeenCalledWith(conn, vitest_1.expect.any(Object));
    });
    (0, vitest_1.it)('translates column types in tablesToCreate', async () => {
        const conn = (0, mock_database_1.createMockConnection)();
        translator.translateColumnType.mockReturnValue('bigint');
        const table = {
            name: 'users',
            columns: [{ name: 'id', dataType: 'integer', isNullable: false, defaultValue: null, characterMaxLength: null, numericPrecision: null, numericScale: null }],
            constraints: [],
            indexes: [],
        };
        const diff = { ...emptyDiff(), tablesToCreate: [table] };
        const useCase = new sync_schema_use_case_1.SyncSchemaUseCase(synchronizer, translator, connection_types_1.DatabaseType.POSTGRES, connection_types_1.DatabaseType.MYSQL, logger);
        await useCase.execute(conn, diff);
        const appliedDiff = synchronizer.apply.mock.calls[0][1];
        (0, vitest_1.expect)(appliedDiff.tablesToCreate[0].columns[0].dataType).toBe('bigint');
    });
    (0, vitest_1.it)('translates default values in columnsToAdd', async () => {
        const conn = (0, mock_database_1.createMockConnection)();
        translator.translateDefaultValue.mockReturnValue('CURRENT_TIMESTAMP');
        const diff = {
            ...emptyDiff(),
            columnsToAdd: [{
                    tableName: 'users',
                    column: { name: 'created_at', dataType: 'timestamp', isNullable: true, defaultValue: 'now()', characterMaxLength: null, numericPrecision: null, numericScale: null },
                }],
        };
        const useCase = new sync_schema_use_case_1.SyncSchemaUseCase(synchronizer, translator, connection_types_1.DatabaseType.POSTGRES, connection_types_1.DatabaseType.MYSQL, logger);
        await useCase.execute(conn, diff);
        const appliedDiff = synchronizer.apply.mock.calls[0][1];
        (0, vitest_1.expect)(appliedDiff.columnsToAdd[0].column.defaultValue).toBe('CURRENT_TIMESTAMP');
    });
});
