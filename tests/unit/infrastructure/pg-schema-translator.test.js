"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const pg_schema_translator_adapter_1 = require("../../../src/infrastructure/database/pg/pg-schema-translator.adapter");
const connection_types_1 = require("../../../src/domain/types/connection.types");
(0, vitest_1.describe)('PgSchemaTranslator', () => {
    let translator;
    (0, vitest_1.beforeEach)(() => {
        translator = new pg_schema_translator_adapter_1.PgSchemaTranslator();
    });
    (0, vitest_1.describe)('translateColumnType', () => {
        (0, vitest_1.it)('returns the source type unchanged for same-db migration', () => {
            (0, vitest_1.expect)(translator.translateColumnType('character varying(255)', connection_types_1.DatabaseType.POSTGRES, connection_types_1.DatabaseType.POSTGRES)).toBe('character varying(255)');
        });
        (0, vitest_1.it)('returns numeric types unchanged', () => {
            (0, vitest_1.expect)(translator.translateColumnType('integer', connection_types_1.DatabaseType.POSTGRES, connection_types_1.DatabaseType.POSTGRES)).toBe('integer');
        });
        (0, vitest_1.it)('returns complex types unchanged', () => {
            (0, vitest_1.expect)(translator.translateColumnType('timestamp without time zone', connection_types_1.DatabaseType.POSTGRES, connection_types_1.DatabaseType.POSTGRES)).toBe('timestamp without time zone');
        });
    });
    (0, vitest_1.describe)('translateDefaultValue', () => {
        (0, vitest_1.it)('returns default expression unchanged', () => {
            (0, vitest_1.expect)(translator.translateDefaultValue('now()', connection_types_1.DatabaseType.POSTGRES, connection_types_1.DatabaseType.POSTGRES)).toBe('now()');
        });
        (0, vitest_1.it)('returns nextval expression unchanged', () => {
            (0, vitest_1.expect)(translator.translateDefaultValue("nextval('users_id_seq'::regclass)", connection_types_1.DatabaseType.POSTGRES, connection_types_1.DatabaseType.POSTGRES)).toBe("nextval('users_id_seq'::regclass)");
        });
        (0, vitest_1.it)('returns null-like string unchanged', () => {
            (0, vitest_1.expect)(translator.translateDefaultValue('NULL', connection_types_1.DatabaseType.POSTGRES, connection_types_1.DatabaseType.POSTGRES)).toBe('NULL');
        });
    });
    (0, vitest_1.describe)('translateConstraint', () => {
        (0, vitest_1.it)('returns primary key constraint unchanged', () => {
            const constraint = {
                name: 'pk_users',
                type: 'PRIMARY KEY',
                columns: ['id'],
            };
            const result = translator.translateConstraint(constraint, connection_types_1.DatabaseType.POSTGRES, connection_types_1.DatabaseType.POSTGRES);
            (0, vitest_1.expect)(result).toBe(constraint);
        });
        (0, vitest_1.it)('returns foreign key constraint unchanged', () => {
            const constraint = {
                name: 'fk_orders_user',
                type: 'FOREIGN KEY',
                columns: ['user_id'],
                referencedTable: 'users',
                referencedColumns: ['id'],
                onDelete: 'CASCADE',
            };
            const result = translator.translateConstraint(constraint, connection_types_1.DatabaseType.POSTGRES, connection_types_1.DatabaseType.POSTGRES);
            (0, vitest_1.expect)(result).toBe(constraint);
        });
        (0, vitest_1.it)('returns check constraint unchanged', () => {
            const constraint = {
                name: 'chk_age',
                type: 'CHECK',
                columns: ['age'],
                checkExpression: 'age > 0',
            };
            const result = translator.translateConstraint(constraint, connection_types_1.DatabaseType.POSTGRES, connection_types_1.DatabaseType.POSTGRES);
            (0, vitest_1.expect)(result).toBe(constraint);
        });
    });
});
