"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const create_database_use_case_1 = require("../../../src/application/use-cases/create-database.use-case");
const mock_database_1 = require("../../helpers/mock-database");
function makeLogger() {
    return { info: vitest_1.vi.fn(), warn: vitest_1.vi.fn(), error: vitest_1.vi.fn(), debug: vitest_1.vi.fn() };
}
(0, vitest_1.describe)('CreateDatabaseUseCase', () => {
    let useCase;
    let logger;
    (0, vitest_1.beforeEach)(() => {
        logger = makeLogger();
        useCase = new create_database_use_case_1.CreateDatabaseUseCase(logger);
    });
    (0, vitest_1.it)('creates the database when it does not exist', async () => {
        const conn = (0, mock_database_1.createMockConnection)();
        conn.query
            .mockResolvedValueOnce([]) // pg_database check returns nothing
            .mockResolvedValueOnce([]); // CREATE DATABASE
        const created = await useCase.execute(conn, 'mydb');
        (0, vitest_1.expect)(created).toBe(true);
        (0, vitest_1.expect)(conn.query).toHaveBeenCalledTimes(2);
        (0, vitest_1.expect)(conn.query.mock.calls[1][0]).toMatch(/CREATE DATABASE/);
    });
    (0, vitest_1.it)('skips creation when database already exists', async () => {
        const conn = (0, mock_database_1.createMockConnection)();
        conn.query.mockResolvedValueOnce([{ datname: 'mydb' }]);
        const created = await useCase.execute(conn, 'mydb');
        (0, vitest_1.expect)(created).toBe(false);
        (0, vitest_1.expect)(conn.query).toHaveBeenCalledTimes(1);
    });
    (0, vitest_1.it)('logs info on skip', async () => {
        const conn = (0, mock_database_1.createMockConnection)();
        conn.query.mockResolvedValueOnce([{ datname: 'mydb' }]);
        await useCase.execute(conn, 'mydb');
        (0, vitest_1.expect)(logger.info).toHaveBeenCalledWith(vitest_1.expect.stringContaining('already exists'));
    });
    (0, vitest_1.it)('logs info on creation', async () => {
        const conn = (0, mock_database_1.createMockConnection)();
        conn.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
        await useCase.execute(conn, 'newdb');
        (0, vitest_1.expect)(logger.info).toHaveBeenCalledWith(vitest_1.expect.stringContaining('created'));
    });
});
