# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run the CLI
npm start                    # ts-node src/index.ts
npm run dev                  # ts-node-dev with hot reload

# Build
npm run build                # tsc → dist/

# Type check (no emit)
npx tsc --noEmit

# Tests
npm test                     # vitest run (all tests, single pass)
npm run test:watch           # vitest watch mode

# Run a single test file
npx vitest run tests/unit/application/migration-orchestrator.service.test.ts
```

## Architecture

This is a database-agnostic CLI migration tool ("Movy") built with **hexagonal architecture**. It migrates schema and data from one database to another.

### Layer overview

```
src/
├── domain/           # Pure types, ports (interfaces), and errors — no I/O
├── application/      # Use cases and orchestration service
├── infrastructure/   # Concrete adapter implementations (pg, future: mysql, mssql, snowflake)
└── presentation/     # CLI entry point and prompt helpers
```

### Domain ports (interfaces)

All database interactions are behind interfaces in `src/domain/ports/`:

| Port | Purpose |
|------|---------|
| `IDatabaseConnection` | Connect / query / end a DB connection |
| `ISchemaInspector` | Inspect tables, columns, constraints, indexes, sequences, enums |
| `ISchemaSynchronizer` | Apply schema diffs, manage triggers, create indexes, reset sequences |
| `ISchemaTranslator` | Translate column types and defaults between DB dialects |
| `IDataMigrator` | Copy row data from source to destination |
| `IQueryAnalyzer` | Analyze a SQL query to infer result column names and types |
| `ILogger` | Structured logging |

### Adapter registration

`DatabaseAdapterRegistry` (`src/infrastructure/database/registry.ts`) maps a `DatabaseType` enum value to a `DatabaseAdapterSet`. Both **PostgreSQL** and **MySQL** are fully registered. Cross-DB translator and migrator pairs are registered separately via `registerTranslator()` and `registerDataMigrator()`.

```
registry.register(DatabaseType.POSTGRES, new PgAdapterSet())
registry.register(DatabaseType.MYSQL, new MysqlAdapterSet())
registry.registerTranslator(MYSQL, POSTGRES, () => new MysqlToPostgresTranslator())
registry.registerTranslator(POSTGRES, MYSQL, () => new PostgresToMysqlTranslator())
registry.registerDataMigrator(MYSQL, POSTGRES, () => new CrossDbDataMigrator())
registry.registerDataMigrator(POSTGRES, MYSQL, () => new CrossDbDataMigrator())
```

To add a new database, implement `DatabaseAdapterSet` and register it (plus any cross-DB translators/migrators) in `cli.ts`.

### CLI app modes

The CLI prompts the user to choose an app mode at startup:

- **migrate** — full migration (schema + data). Sub-modes: `full` (entire database) or `query` (custom SQL → new table via `MigrateQueryUseCase`). After migration, optionally runs row count validation.
- **validate** — connects to both databases and runs `ValidateCountsUseCase` to compare per-table row counts without migrating anything.

Logs are written to both the console and a timestamped file under `logs/` (`movy_YYYY-MM-DD_HH-MM-SS_src_to_dst.log`) via `TeeLogger`.

### Migration flow (MigrationOrchestrator)

1. Create target database if absent (using an admin connection to `postgres` db)
2. Inspect source schema and diff against destination schema
3. Apply schema diff (tables, columns, constraints — but not indexes yet)
4. Disable triggers on destination
5. Migrate data via `WorkerPool` (parallel `pg-copy-streams` workers per table)
6. Re-enable triggers
7. Create indexes
8. Reset sequences

### Cross-database migrations

When source and destination are **different** engine types (MySQL↔PostgreSQL), `CrossDbDataMigrator` (`src/infrastructure/migration/cross-db-data-migrator.ts`) is used instead of the engine-native migrator. It reads rows in batches (`BATCH_SIZE=500`) via SELECT and writes them with batch INSERT — no worker threads, sequential per table.

Schema type mapping is handled by `CrossDbSchemaTranslator` subclasses:
- `MysqlToPostgresTranslator` — MySQL → PostgreSQL type/default translation
- `PostgresToMysqlTranslator` — PostgreSQL → MySQL type/default translation

Both extend `CrossDbSchemaTranslator` (`src/infrastructure/database/translation/cross-db-schema-translator.ts`), which does normalised type lookup with precision-suffix propagation.

### Data migration concurrency (same-engine)

`WorkerPool` (`src/infrastructure/migration/worker-pool.ts`) spawns worker threads (`table-copy.worker.ts`) to COPY each table in parallel using `pg-copy-streams`. This path is used for PostgreSQL→PostgreSQL migrations only. Row estimates from `ISchemaInspector.getTableRowEstimates` are used to order tables (largest first).

### Schema types

`src/domain/types/schema.types.ts` defines the canonical in-memory schema representation: `DatabaseSchema` → `TableSchema[]` + `SequenceSchema[]` + `EnumSchema[]`. Each `TableSchema` has `ColumnSchema[]`, `ConstraintSchema[]`, and `IndexSchema[]`.

### Tests

- Unit tests live in `tests/unit/` and are the only tests currently implemented.
- Integration tests directory exists (`tests/integration/`) with a README explaining they require real DB connections and are not automated.
- `tests/helpers/mock-database.ts` provides shared mock `IDatabaseConnection` for unit tests.
- Tests use **Vitest** with `globals: true`, `pool: 'forks'`.
