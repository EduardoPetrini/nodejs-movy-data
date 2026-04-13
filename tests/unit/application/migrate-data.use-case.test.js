"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const migrate_data_use_case_1 = require("../../../src/application/use-cases/migrate-data.use-case");
const connection_types_1 = require("../../../src/domain/types/connection.types");
function makeLogger() {
    return { info: vitest_1.vi.fn(), warn: vitest_1.vi.fn(), error: vitest_1.vi.fn(), debug: vitest_1.vi.fn() };
}
function makeConfig(db = 'testdb') {
    return { type: connection_types_1.DatabaseType.POSTGRES, host: 'localhost', port: 5432, user: 'u', password: 'p', database: db };
}
function makeResult(success = true) {
    return {
        tables: [{ tableName: 'users', rowsCopied: 100, durationMs: 50, success }],
        totalDurationMs: 100,
        success,
    };
}
(0, vitest_1.describe)('MigrateDataUseCase', () => {
    let migrator;
    let logger;
    let useCase;
    (0, vitest_1.beforeEach)(() => {
        migrator = { migrate: vitest_1.vi.fn().mockResolvedValue(makeResult()) };
        logger = makeLogger();
        useCase = new migrate_data_use_case_1.MigrateDataUseCase(migrator, logger);
    });
    (0, vitest_1.it)('calls migrator.migrate with sorted tables and worker count', async () => {
        const estimates = new Map([['users', 1000], ['orders', 5000]]);
        await useCase.execute(makeConfig(), makeConfig('dest'), ['users', 'orders'], estimates);
        const call = migrator.migrate.mock.calls[0];
        // orders has more rows, should be first
        (0, vitest_1.expect)(call[2][0]).toBe('orders');
        (0, vitest_1.expect)(call[2][1]).toBe('users');
    });
    (0, vitest_1.it)('caps workers at 4', async () => {
        const tables = ['a', 'b', 'c', 'd', 'e', 'f'];
        await useCase.execute(makeConfig(), makeConfig('dest'), tables, new Map());
        const workerCount = migrator.migrate.mock.calls[0][3];
        (0, vitest_1.expect)(workerCount).toBeLessThanOrEqual(4);
    });
    (0, vitest_1.it)('returns migration result', async () => {
        const result = await useCase.execute(makeConfig(), makeConfig('dest'), ['users'], new Map());
        (0, vitest_1.expect)(result.success).toBe(true);
    });
    (0, vitest_1.it)('logs the summary table', async () => {
        await useCase.execute(makeConfig(), makeConfig('dest'), ['users'], new Map());
        const calls = logger.info.mock.calls.map((c) => c[0]);
        // The summary contains a header row and a totals row
        (0, vitest_1.expect)(calls.some((c) => c.includes('Table'))).toBe(true);
        (0, vitest_1.expect)(calls.some((c) => c.includes('TOTAL'))).toBe(true);
    });
});
