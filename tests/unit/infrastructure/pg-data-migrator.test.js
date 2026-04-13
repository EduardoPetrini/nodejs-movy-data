"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const pg_data_migrator_adapter_1 = require("../../../src/infrastructure/migration/pg-data-migrator.adapter");
const connection_types_1 = require("../../../src/domain/types/connection.types");
function makeConfig(db = 'src') {
    return { type: connection_types_1.DatabaseType.POSTGRES, host: 'localhost', port: 5432, user: 'u', password: 'p', database: db };
}
function makeTableResult(tableName, success = true) {
    return { tableName, rowsCopied: 10, durationMs: 5, success };
}
(0, vitest_1.describe)('PgDataMigrator', () => {
    let pool;
    let migrator;
    (0, vitest_1.beforeEach)(() => {
        pool = { run: vitest_1.vi.fn().mockResolvedValue([makeTableResult('users')]) };
        migrator = new pg_data_migrator_adapter_1.PgDataMigrator(pool);
    });
    (0, vitest_1.it)('delegates to WorkerPool.run', async () => {
        await migrator.migrate(makeConfig(), makeConfig('dst'), ['users'], 2);
        (0, vitest_1.expect)(pool.run).toHaveBeenCalledWith(makeConfig(), makeConfig('dst'), ['users'], 2, undefined, undefined);
    });
    (0, vitest_1.it)('returns success=true when all tables succeed', async () => {
        const result = await migrator.migrate(makeConfig(), makeConfig('dst'), ['users'], 1);
        (0, vitest_1.expect)(result.success).toBe(true);
    });
    (0, vitest_1.it)('returns success=false when any table fails', async () => {
        pool.run.mockResolvedValue([
            makeTableResult('users', true),
            makeTableResult('orders', false),
        ]);
        const result = await migrator.migrate(makeConfig(), makeConfig('dst'), ['users', 'orders'], 1);
        (0, vitest_1.expect)(result.success).toBe(false);
    });
    (0, vitest_1.it)('includes totalDurationMs in result', async () => {
        const result = await migrator.migrate(makeConfig(), makeConfig('dst'), ['users'], 1);
        (0, vitest_1.expect)(result.totalDurationMs).toBeGreaterThanOrEqual(0);
    });
});
