"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const registry_1 = require("../../../src/infrastructure/database/registry");
const connection_types_1 = require("../../../src/domain/types/connection.types");
const migration_errors_1 = require("../../../src/domain/errors/migration.errors");
function makeFakeAdapterSet() {
    return {
        createConnection: vitest_1.vi.fn(),
        createSchemaInspector: vitest_1.vi.fn(),
        createSchemaSynchronizer: vitest_1.vi.fn(),
        createDataMigrator: vitest_1.vi.fn(),
    };
}
(0, vitest_1.describe)('DatabaseAdapterRegistry', () => {
    let registry;
    (0, vitest_1.beforeEach)(() => {
        registry = new registry_1.DatabaseAdapterRegistry();
    });
    (0, vitest_1.describe)('register / has / get', () => {
        (0, vitest_1.it)('returns false for unregistered type', () => {
            (0, vitest_1.expect)(registry.has(connection_types_1.DatabaseType.POSTGRES)).toBe(false);
        });
        (0, vitest_1.it)('returns true after registration', () => {
            registry.register(connection_types_1.DatabaseType.POSTGRES, makeFakeAdapterSet());
            (0, vitest_1.expect)(registry.has(connection_types_1.DatabaseType.POSTGRES)).toBe(true);
        });
        (0, vitest_1.it)('returns the registered adapter set', () => {
            const set = makeFakeAdapterSet();
            registry.register(connection_types_1.DatabaseType.POSTGRES, set);
            (0, vitest_1.expect)(registry.get(connection_types_1.DatabaseType.POSTGRES)).toBe(set);
        });
        (0, vitest_1.it)('throws UnsupportedDatabaseError for unregistered type', () => {
            (0, vitest_1.expect)(() => registry.get(connection_types_1.DatabaseType.MYSQL)).toThrow(migration_errors_1.UnsupportedDatabaseError);
        });
        (0, vitest_1.it)('includes the requested type in the error message', () => {
            (0, vitest_1.expect)(() => registry.get(connection_types_1.DatabaseType.MYSQL)).toThrow(/mysql/);
        });
        (0, vitest_1.it)('includes available types in the error message', () => {
            registry.register(connection_types_1.DatabaseType.POSTGRES, makeFakeAdapterSet());
            (0, vitest_1.expect)(() => registry.get(connection_types_1.DatabaseType.MYSQL)).toThrow(/postgres/);
        });
    });
    (0, vitest_1.describe)('getTranslator', () => {
        (0, vitest_1.it)('returns PassthroughSchemaTranslator when source and dest are the same', () => {
            registry.register(connection_types_1.DatabaseType.POSTGRES, makeFakeAdapterSet());
            const translator = registry.getTranslator(connection_types_1.DatabaseType.POSTGRES, connection_types_1.DatabaseType.POSTGRES);
            (0, vitest_1.expect)(translator).toBeInstanceOf(registry_1.PassthroughSchemaTranslator);
        });
        (0, vitest_1.it)('returns PassthroughSchemaTranslator when adapter has no createSchemaTranslator', () => {
            registry.register(connection_types_1.DatabaseType.POSTGRES, makeFakeAdapterSet());
            registry.register(connection_types_1.DatabaseType.MYSQL, makeFakeAdapterSet());
            const translator = registry.getTranslator(connection_types_1.DatabaseType.POSTGRES, connection_types_1.DatabaseType.MYSQL);
            (0, vitest_1.expect)(translator).toBeInstanceOf(registry_1.PassthroughSchemaTranslator);
        });
        (0, vitest_1.it)('uses createSchemaTranslator from source adapter set when available', () => {
            const fakeTranslator = new registry_1.PassthroughSchemaTranslator();
            const set = { ...makeFakeAdapterSet(), createSchemaTranslator: vitest_1.vi.fn(() => fakeTranslator) };
            registry.register(connection_types_1.DatabaseType.POSTGRES, set);
            registry.register(connection_types_1.DatabaseType.MYSQL, makeFakeAdapterSet());
            const translator = registry.getTranslator(connection_types_1.DatabaseType.POSTGRES, connection_types_1.DatabaseType.MYSQL);
            (0, vitest_1.expect)(translator).toBe(fakeTranslator);
            (0, vitest_1.expect)(set.createSchemaTranslator).toHaveBeenCalled();
        });
    });
    (0, vitest_1.describe)('PassthroughSchemaTranslator', () => {
        let translator;
        (0, vitest_1.beforeEach)(() => {
            translator = new registry_1.PassthroughSchemaTranslator();
        });
        (0, vitest_1.it)('returns column type unchanged', () => {
            (0, vitest_1.expect)(translator.translateColumnType('VARCHAR(255)', connection_types_1.DatabaseType.POSTGRES, connection_types_1.DatabaseType.POSTGRES)).toBe('VARCHAR(255)');
        });
        (0, vitest_1.it)('returns default value unchanged', () => {
            (0, vitest_1.expect)(translator.translateDefaultValue('now()', connection_types_1.DatabaseType.POSTGRES, connection_types_1.DatabaseType.POSTGRES)).toBe('now()');
        });
        (0, vitest_1.it)('returns constraint unchanged', () => {
            const constraint = {
                name: 'pk_users',
                type: 'PRIMARY KEY',
                columns: ['id'],
            };
            (0, vitest_1.expect)(translator.translateConstraint(constraint, connection_types_1.DatabaseType.POSTGRES, connection_types_1.DatabaseType.POSTGRES)).toBe(constraint);
        });
    });
});
