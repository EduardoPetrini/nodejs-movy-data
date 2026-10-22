# MySQL Adapter

Fully implemented. Registered in `src/presentation/cli/cli.ts` alongside the PostgreSQL adapter.

## Files

| File | Purpose |
|------|---------|
| `mysql-connection.adapter.ts` | `IDatabaseConnection` — pool-based connection using `mysql2/promise` |
| `mysql-schema-inspector.adapter.ts` | `ISchemaInspector` — introspects via `information_schema` + `SHOW INDEXES` |
| `mysql-schema-synchronizer.adapter.ts` | `ISchemaSynchronizer` — DDL apply, FK checks, AUTO_INCREMENT reset |
| `mysql-query-analyzer.adapter.ts` | `IQueryAnalyzer` — infers column types via `DESCRIBE` on a temp view |
| `mysql-to-postgres-translator.adapter.ts` | `ISchemaTranslator` — delegates to `MysqlToPostgresTranslator` |
| `mysql-adapter-set.ts` | `DatabaseAdapterSet` — wires all adapters together |

## Type translation

MySQL → PostgreSQL translation uses `MYSQL_TO_POSTGRES_TYPE_MAP` via `CrossDbSchemaTranslator`.
PostgreSQL → MySQL translation uses `POSTGRES_TO_MYSQL_TYPE_MAP` via `PostgresToMysqlTranslator`.

See `src/infrastructure/database/translation/` for the type maps and base translator.

## FK handling

FK checks are disabled via `SET SESSION FOREIGN_KEY_CHECKS = 0` before data copy and
re-enabled with `SET SESSION FOREIGN_KEY_CHECKS = 1` after. `disableTriggers` /
`enableTriggers` on `MysqlSchemaSynchronizer` wrap these statements.

## AUTO_INCREMENT reset

`resetSequences()` reads the current max value per table from the source and issues
`ALTER TABLE ... AUTO_INCREMENT = <value>` on the destination.
