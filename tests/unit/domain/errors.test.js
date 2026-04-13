"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const migration_errors_1 = require("../../../src/domain/errors/migration.errors");
const connection_types_1 = require("../../../src/domain/types/connection.types");
(0, vitest_1.describe)('MigrationError', () => {
    (0, vitest_1.it)('sets message and name', () => {
        const err = new migration_errors_1.MigrationError('something went wrong');
        (0, vitest_1.expect)(err.message).toBe('something went wrong');
        (0, vitest_1.expect)(err.name).toBe('MigrationError');
        (0, vitest_1.expect)(err).toBeInstanceOf(Error);
    });
});
(0, vitest_1.describe)('ConnectionError', () => {
    (0, vitest_1.it)('is a MigrationError', () => {
        const err = new migration_errors_1.ConnectionError('cannot connect');
        (0, vitest_1.expect)(err.name).toBe('ConnectionError');
        (0, vitest_1.expect)(err).toBeInstanceOf(migration_errors_1.MigrationError);
    });
});
(0, vitest_1.describe)('SchemaInspectionError', () => {
    (0, vitest_1.it)('is a MigrationError', () => {
        const err = new migration_errors_1.SchemaInspectionError('bad schema');
        (0, vitest_1.expect)(err.name).toBe('SchemaInspectionError');
        (0, vitest_1.expect)(err).toBeInstanceOf(migration_errors_1.MigrationError);
    });
});
(0, vitest_1.describe)('SchemaSyncError', () => {
    (0, vitest_1.it)('is a MigrationError', () => {
        const err = new migration_errors_1.SchemaSyncError('sync failed');
        (0, vitest_1.expect)(err.name).toBe('SchemaSyncError');
        (0, vitest_1.expect)(err).toBeInstanceOf(migration_errors_1.MigrationError);
    });
});
(0, vitest_1.describe)('DataMigrationError', () => {
    (0, vitest_1.it)('is a MigrationError', () => {
        const err = new migration_errors_1.DataMigrationError('data copy failed');
        (0, vitest_1.expect)(err.name).toBe('DataMigrationError');
        (0, vitest_1.expect)(err).toBeInstanceOf(migration_errors_1.MigrationError);
    });
});
(0, vitest_1.describe)('CustomTypeError', () => {
    (0, vitest_1.it)('includes the type name in the message', () => {
        const err = new migration_errors_1.CustomTypeError('my_enum');
        (0, vitest_1.expect)(err.name).toBe('CustomTypeError');
        (0, vitest_1.expect)(err.message).toContain('my_enum');
        (0, vitest_1.expect)(err.message).toContain('v1');
        (0, vitest_1.expect)(err).toBeInstanceOf(migration_errors_1.MigrationError);
    });
});
(0, vitest_1.describe)('UnsupportedDatabaseError', () => {
    (0, vitest_1.it)('includes the requested type and available types', () => {
        const err = new migration_errors_1.UnsupportedDatabaseError(connection_types_1.DatabaseType.MYSQL, [connection_types_1.DatabaseType.POSTGRES]);
        (0, vitest_1.expect)(err.name).toBe('UnsupportedDatabaseError');
        (0, vitest_1.expect)(err.message).toContain('mysql');
        (0, vitest_1.expect)(err.message).toContain('postgres');
        (0, vitest_1.expect)(err).toBeInstanceOf(migration_errors_1.MigrationError);
    });
    (0, vitest_1.it)('includes planned version for mysql', () => {
        const err = new migration_errors_1.UnsupportedDatabaseError(connection_types_1.DatabaseType.MYSQL, [connection_types_1.DatabaseType.POSTGRES]);
        (0, vitest_1.expect)(err.message).toContain('v2');
    });
    (0, vitest_1.it)('includes planned version for mssql', () => {
        const err = new migration_errors_1.UnsupportedDatabaseError(connection_types_1.DatabaseType.MSSQL, [connection_types_1.DatabaseType.POSTGRES]);
        (0, vitest_1.expect)(err.message).toContain('v3');
    });
    (0, vitest_1.it)('includes planned version for snowflake', () => {
        const err = new migration_errors_1.UnsupportedDatabaseError(connection_types_1.DatabaseType.SNOWFLAKE, [connection_types_1.DatabaseType.POSTGRES]);
        (0, vitest_1.expect)(err.message).toContain('v3');
    });
});
