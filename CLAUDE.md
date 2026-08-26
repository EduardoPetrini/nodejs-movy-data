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
├── infrastructure/   # Concrete adapter implementations (pg, mysql, translators, migrators)
└── presentation/     # CLI entry point and prompt helpers
```

### Domain ports (interfaces)

All database interactions are behind interfaces in `src/domain/ports/`:

| Port | Purpose |
|------|---------|
| `IDatabaseConnection` | Connect / query / end a DB connection |
| `ISchemaInspector` | Inspect tables, columns, constraints, indexes, sequences, enums |
| `ISchemaSynchronizer` | Apply schema diffs, manage triggers/FK-checks, create indexes, reset sequences |
| `ISchemaTranslator` | Translate column types and defaults between DB dialects |
| `IDataMigrator` | Copy row data from source to destination |
| `IQueryAnalyzer` | Analyze a SQL query to infer result column names and types |
| `ILogger` | Structured logging |

### Adapter registration

`DatabaseAdapterRegistry` (`src/infrastructure/database/registry.ts`) maps a `DatabaseType` to a `DatabaseAdapterSet`. **PostgreSQL**, **MySQL** and **MSSQL** are fully registered. Cross-DB translator and migrator pairs are registered separately via `registerTranslator()` and `registerDataMigrator()`.

```
registry.register(DatabaseType.POSTGRES, new PgAdapterSet())
registry.register(DatabaseType.MYSQL, new MysqlAdapterSet())
registry.register(DatabaseType.MSSQL, new MssqlAdapterSet())

registry.registerTranslator(MYSQL, POSTGRES, () => new MysqlToPostgresTranslator())
registry.registerTranslator(POSTGRES, MYSQL, () => new PostgresToMysqlTranslator())
registry.registerTranslator(MSSQL, POSTGRES, () => new MssqlToPostgresTranslator())
registry.registerTranslator(POSTGRES, MSSQL, () => new PostgresToMssqlTranslator())
registry.registerTranslator(MSSQL, MYSQL, () => new MssqlToMysqlTranslator())
registry.registerTranslator(MYSQL, MSSQL, () => new MysqlToMssqlTranslator())

registry.registerDataMigrator(MYSQL, POSTGRES, () => new CrossDbDataMigrator())
registry.registerDataMigrator(POSTGRES, MYSQL, () => new CrossDbDataMigrator())
registry.registerDataMigrator(MSSQL, POSTGRES, () => new MssqlCrossDbDataMigrator())
registry.registerDataMigrator(POSTGRES, MSSQL, () => new MssqlCrossDbDataMigrator())
registry.registerDataMigrator(MSSQL, MYSQL, () => new MssqlCrossDbDataMigrator())
registry.registerDataMigrator(MYSQL, MSSQL, () => new MssqlCrossDbDataMigrator())
```

To add a new database, implement `DatabaseAdapterSet` and register it plus any cross-DB translators/migrators in `cli.ts`. Adding engine `n + 1` costs `2n` new type maps and `2n` new translators — see `docs/adr/0001-direct-pair-type-translation.md`.

### Application services

| Service | Purpose |
|---------|---------|
| `MigrationOrchestrator` | Orchestrates the full migration flow (9 steps) |
| `TableMigrationPlanner` | Topologically sorts tables by FK dependency; produces `TableMigrationPlan` with `loadOrder`, `cleanupOrder`, `levels`, and `cyclicTables` |

`MigrateDataUseCase` creates a `TableMigrationPlanner` internally and calls `planner.plan(tables, rowEstimates)` to determine the correct copy order before invoking the data migrator.

### CLI app modes

The CLI prompts the user to choose an app mode at startup:

- **migrate / full** — full migration (schema + data). After migration, optionally runs row count validation.
- **migrate / query** — custom SQL → new table via `MigrateQueryUseCase` (PostgreSQL source **and** destination only — it streams via PG `COPY` and casts both connections to `PgConnection`).
- **validate** — connects to both databases and runs `ValidateCountsUseCase` to compare per-table row counts without migrating anything.

Logs are written to both the console and a timestamped file under `logs/` (`movy_YYYY-MM-DD_HH-MM-SS_src_to_dst.log`) via `TeeLogger`.

### Migration flow (MigrationOrchestrator)

1. Create target database if absent (via `ensureDatabase()` on an admin connection)
2. Inspect source schema and diff against destination schema
3. Apply schema diff (tables, columns, constraints — but not indexes yet); types run through `ISchemaTranslator`
4. Disable FK checks / triggers on destination
5. Fetch row estimates from source; `TableMigrationPlanner` topologically sorts tables by FK dependency to produce a `TableMigrationPlan`
6. Migrate data using the appropriate migrator for the source↔dest pair (plan determines load order)
7. Re-enable FK checks / triggers
8. Create indexes
9. Reset auto-increment state (PG: `setval()`; MySQL: `ALTER TABLE … AUTO_INCREMENT`; MSSQL: `DBCC CHECKIDENT … RESEED`)

### Data migration — migrator selection

`registry.getDataMigrator(source, dest)` selects:
- **PG→PG**: `PgDataMigrator` — `WorkerPool` + `pg-copy-streams`, parallel worker threads (up to 4), largest tables first
- **MySQL→MySQL**: `MysqlDataMigrator` — batched SELECT + INSERT (`BATCH_SIZE=500`), sequential
- **MSSQL→MSSQL**: `MssqlDataMigrator` — batched SELECT + INSERT (`BATCH_SIZE=500`), sequential, `IDENTITY_INSERT` toggled per table
- **MySQL↔PG**: `CrossDbDataMigrator` — batched SELECT + INSERT, sequential, handles both directions
- **MSSQL↔PG / MSSQL↔MySQL**: `MssqlCrossDbDataMigrator` — batched SELECT + INSERT, sequential, IDENTITY detection for MSSQL destinations

### Cross-database schema translation

`CrossDbSchemaTranslator` (`src/infrastructure/database/translation/cross-db-schema-translator.ts`) is the abstract base class. It does normalised type lookup with precision-suffix propagation. Concrete subclasses:
- `MysqlToPostgresTranslator` — uses `MYSQL_TO_POSTGRES_TYPE_MAP`
- `PostgresToMysqlTranslator` — uses `POSTGRES_TO_MYSQL_TYPE_MAP`
- `MssqlToPostgresTranslator` — uses `MSSQL_TO_POSTGRES_TYPE_MAP`
- `MssqlToMysqlTranslator` — uses `MSSQL_TO_MYSQL_TYPE_MAP`
- `PostgresToMssqlTranslator` — uses `POSTGRES_TO_MSSQL_TYPE_MAP`
- `MysqlToMssqlTranslator` — uses `MYSQL_TO_MSSQL_TYPE_MAP`

Default-value translation is delegated to `DefaultValueTranslator`, injected into each subclass.

### Schema types

`src/domain/types/schema.types.ts` defines the canonical in-memory schema representation: `DatabaseSchema` → `TableSchema[]` + `SequenceSchema[]` + `EnumSchema[]`. Each `TableSchema` has `ColumnSchema[]`, `ConstraintSchema[]`, and `IndexSchema[]`.

### Tests

- Unit tests live in `tests/unit/` and are the only tests currently implemented.
- Integration tests directory exists (`tests/integration/`) with a README explaining they require real DB connections and are not automated.
- `tests/helpers/mock-database.ts` provides shared mock `IDatabaseConnection` for unit tests.
- Tests use **Vitest** with `globals: true`, `pool: 'forks'`.
- The whole suite is mock-driven and runs without any database.
- `npm run test:coverage` produces a coverage report. Thresholds in `vitest.config.ts` are set to the current measured floor and ratchet upward; the target is 80%.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `EduardoPetrini/nodejs-movy-data`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

Key vocabulary (full definitions in `CONTEXT.md`): a **Pair** is one directional migration
route and is the unit of completion; an **Adapter Set** is the per-engine wiring class; a
Pair is **Done** when implemented and covered by automated tests against mocks — a live
database is not required. Avoid the word "connector".
