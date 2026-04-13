"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const migration_orchestrator_service_1 = require("../../../src/application/services/migration-orchestrator.service");
const registry_1 = require("../../../src/infrastructure/database/registry");
const connection_types_1 = require("../../../src/domain/types/connection.types");
function makeLogger() {
    return { info: vitest_1.vi.fn(), warn: vitest_1.vi.fn(), error: vitest_1.vi.fn(), debug: vitest_1.vi.fn() };
}
function makeConfig(db = 'src') {
    return { type: connection_types_1.DatabaseType.POSTGRES, host: 'localhost', port: 5432, user: 'u', password: 'p', database: db };
}
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
function makeSuccessResult() {
    return { tables: [], totalDurationMs: 10, success: true };
}
function makeConnection() {
    return {
        connect: vitest_1.vi.fn().mockResolvedValue(undefined),
        query: vitest_1.vi.fn().mockResolvedValue([]),
        getClient: vitest_1.vi.fn(),
        end: vitest_1.vi.fn().mockResolvedValue(undefined),
    };
}
function makeAdapterSet() {
    return {
        createConnection: vitest_1.vi.fn(() => makeConnection()),
        createSchemaInspector: vitest_1.vi.fn(() => ({
            inspect: vitest_1.vi.fn().mockResolvedValue(emptySchema()),
            getTableRowEstimates: vitest_1.vi.fn().mockResolvedValue(new Map()),
        })),
        createSchemaSynchronizer: vitest_1.vi.fn(() => ({
            diff: vitest_1.vi.fn().mockReturnValue(emptyDiff()),
            apply: vitest_1.vi.fn().mockResolvedValue(undefined),
            disableTriggers: vitest_1.vi.fn().mockResolvedValue(undefined),
            enableTriggers: vitest_1.vi.fn().mockResolvedValue(undefined),
            createIndexes: vitest_1.vi.fn().mockResolvedValue(undefined),
            resetSequences: vitest_1.vi.fn().mockResolvedValue(undefined),
        })),
        createDataMigrator: vitest_1.vi.fn(() => ({
            migrate: vitest_1.vi.fn().mockResolvedValue(makeSuccessResult()),
        })),
    };
}
(0, vitest_1.describe)('MigrationOrchestrator', () => {
    let registry;
    let logger;
    let adapterSet;
    (0, vitest_1.beforeEach)(() => {
        registry = new registry_1.DatabaseAdapterRegistry();
        logger = makeLogger();
        adapterSet = makeAdapterSet();
        registry.register(connection_types_1.DatabaseType.POSTGRES, adapterSet);
    });
    (0, vitest_1.it)('runs full migration flow and returns a result', async () => {
        const orchestrator = new migration_orchestrator_service_1.MigrationOrchestrator(registry, logger);
        const result = await orchestrator.run(makeConfig('src'), makeConfig('dst'));
        (0, vitest_1.expect)(result.success).toBe(true);
    });
    (0, vitest_1.it)('throws UnsupportedDatabaseError for unregistered source type', async () => {
        const registry2 = new registry_1.DatabaseAdapterRegistry();
        // intentionally empty registry
        const orchestrator = new migration_orchestrator_service_1.MigrationOrchestrator(registry2, logger);
        await (0, vitest_1.expect)(orchestrator.run(makeConfig(), makeConfig('dst'))).rejects.toThrow(/not yet implemented/);
    });
    (0, vitest_1.it)('calls disableTriggers before migrate and enableTriggers after', async () => {
        const orchestrator = new migration_orchestrator_service_1.MigrationOrchestrator(registry, logger);
        await orchestrator.run(makeConfig('src'), makeConfig('dst'));
        const synchronizer = adapterSet.createSchemaSynchronizer.mock.results[0].value;
        const disableOrder = synchronizer.disableTriggers.mock.invocationCallOrder[0];
        const migrateOrder = adapterSet.createDataMigrator.mock.results[0].value.migrate.mock.invocationCallOrder[0];
        const enableOrder = synchronizer.enableTriggers.mock.invocationCallOrder[0];
        (0, vitest_1.expect)(disableOrder).toBeLessThan(migrateOrder);
        (0, vitest_1.expect)(migrateOrder).toBeLessThan(enableOrder);
    });
    (0, vitest_1.it)('always closes connections even on error', async () => {
        const failingAdapterSet = {
            ...makeAdapterSet(),
            createSchemaInspector: vitest_1.vi.fn(() => ({
                inspect: vitest_1.vi.fn().mockRejectedValue(new Error('inspect failed')),
                getTableRowEstimates: vitest_1.vi.fn(),
            })),
        };
        registry.register(connection_types_1.DatabaseType.POSTGRES, failingAdapterSet);
        const orchestrator = new migration_orchestrator_service_1.MigrationOrchestrator(registry, logger);
        await (0, vitest_1.expect)(orchestrator.run(makeConfig(), makeConfig('dst'))).rejects.toThrow();
        // All connections created by failingAdapterSet should have end() called
        const connections = failingAdapterSet.createConnection.mock.results.map((r) => r.value);
        for (const conn of connections) {
            (0, vitest_1.expect)(conn.end).toHaveBeenCalled();
        }
    });
});
