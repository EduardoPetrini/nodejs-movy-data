"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const worker_pool_1 = require("../../../src/infrastructure/migration/worker-pool");
const connection_types_1 = require("../../../src/domain/types/connection.types");
vitest_1.vi.mock('worker_threads', () => {
    const EventEmitter = require('events');
    class MockWorker extends EventEmitter {
        constructor(_path, _opts) {
            super();
            setTimeout(() => {
                this.emit('message', { type: 'table_done', tableName: 'users', rowsCopied: 10, durationMs: 5 });
                this.emit('exit', 0);
            }, 0);
        }
    }
    return { Worker: MockWorker };
});
vitest_1.vi.mock('../../../src/shared/utils', () => ({
    resolveWorkerPath: vitest_1.vi.fn(() => '/fake/worker.ts'),
    chunkArray: (arr, size) => {
        const chunks = [];
        for (let i = 0; i < arr.length; i += size)
            chunks.push(arr.slice(i, i + size));
        return chunks;
    },
}));
function makeConfig() {
    return { type: connection_types_1.DatabaseType.POSTGRES, host: 'localhost', port: 5432, user: 'u', password: 'p', database: 'db' };
}
(0, vitest_1.describe)('WorkerPool', () => {
    let pool;
    (0, vitest_1.beforeEach)(() => {
        pool = new worker_pool_1.WorkerPool();
        vitest_1.vi.clearAllMocks();
    });
    (0, vitest_1.it)('returns table results from worker messages', async () => {
        const results = await pool.run(makeConfig(), makeConfig(), ['users'], 1);
        (0, vitest_1.expect)(results).toHaveLength(1);
        (0, vitest_1.expect)(results[0].tableName).toBe('users');
        (0, vitest_1.expect)(results[0].success).toBe(true);
        (0, vitest_1.expect)(results[0].rowsCopied).toBe(10);
    });
    (0, vitest_1.it)('returns results for multiple tables across workers', async () => {
        const results = await pool.run(makeConfig(), makeConfig(), ['users', 'orders'], 2);
        // Each worker emits one table_done for 'users' (from mock)
        (0, vitest_1.expect)(results.length).toBeGreaterThan(0);
        (0, vitest_1.expect)(results.every((r) => r.success)).toBe(true);
    });
});
