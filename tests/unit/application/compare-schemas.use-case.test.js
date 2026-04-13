"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const compare_schemas_use_case_1 = require("../../../src/application/use-cases/compare-schemas.use-case");
const mock_database_1 = require("../../helpers/mock-database");
function emptySchema() {
    return { tables: [], sequences: [], enums: [] };
}
function emptyDiff() {
    return {
        tablesToCreate: [], tablesToDrop: [], columnsToAdd: [], columnsToDrop: [],
        columnsToAlter: [], constraintsToAdd: [], constraintsToDrop: [],
        indexesToCreate: [], indexesToDrop: [], sequencesToCreate: [], enumsToCreate: [],
    };
}
function makeLogger() {
    return { info: vitest_1.vi.fn(), warn: vitest_1.vi.fn(), error: vitest_1.vi.fn(), debug: vitest_1.vi.fn() };
}
(0, vitest_1.describe)('CompareSchemasUseCase', () => {
    let useCase;
    let inspector;
    let synchronizer;
    let logger;
    (0, vitest_1.beforeEach)(() => {
        inspector = {
            inspect: vitest_1.vi.fn().mockResolvedValue(emptySchema()),
            getTableRowEstimates: vitest_1.vi.fn().mockResolvedValue(new Map()),
        };
        synchronizer = {
            diff: vitest_1.vi.fn().mockReturnValue(emptyDiff()),
            apply: vitest_1.vi.fn(),
            disableTriggers: vitest_1.vi.fn(),
            enableTriggers: vitest_1.vi.fn(),
            createIndexes: vitest_1.vi.fn(),
            resetSequences: vitest_1.vi.fn(),
        };
        logger = makeLogger();
        useCase = new compare_schemas_use_case_1.CompareSchemasUseCase(inspector, synchronizer, logger);
    });
    (0, vitest_1.it)('calls inspect on both connections', async () => {
        const src = (0, mock_database_1.createMockConnection)();
        const dst = (0, mock_database_1.createMockConnection)();
        await useCase.execute(src, dst);
        (0, vitest_1.expect)(inspector.inspect).toHaveBeenCalledTimes(2);
        (0, vitest_1.expect)(inspector.inspect).toHaveBeenCalledWith(src);
        (0, vitest_1.expect)(inspector.inspect).toHaveBeenCalledWith(dst);
    });
    (0, vitest_1.it)('passes source and target schemas to diff', async () => {
        const srcSchema = {
            tables: [{ name: 'users', columns: [], constraints: [], indexes: [] }],
            sequences: [],
            enums: [],
        };
        const dstSchema = emptySchema();
        inspector.inspect
            .mockResolvedValueOnce(srcSchema)
            .mockResolvedValueOnce(dstSchema);
        const src = (0, mock_database_1.createMockConnection)();
        const dst = (0, mock_database_1.createMockConnection)();
        await useCase.execute(src, dst);
        (0, vitest_1.expect)(synchronizer.diff).toHaveBeenCalledWith(srcSchema, dstSchema);
    });
    (0, vitest_1.it)('returns sourceSchema, targetSchema and diff', async () => {
        const srcSchema = emptySchema();
        const dstSchema = emptySchema();
        const diff = emptyDiff();
        inspector.inspect.mockResolvedValueOnce(srcSchema).mockResolvedValueOnce(dstSchema);
        synchronizer.diff.mockReturnValue(diff);
        const src = (0, mock_database_1.createMockConnection)();
        const dst = (0, mock_database_1.createMockConnection)();
        const result = await useCase.execute(src, dst);
        (0, vitest_1.expect)(result.sourceSchema).toBe(srcSchema);
        (0, vitest_1.expect)(result.targetSchema).toBe(dstSchema);
        (0, vitest_1.expect)(result.diff).toBe(diff);
    });
});
