# Movy — Database Migration Platform: Implementation Plan

## Context

CLI-based data migration platform that moves schema and data between databases. The user provides source and destination connection details via interactive prompts. The system creates the destination database if needed, enforces the source schema as the source of truth, then migrates data. Target: small-to-medium databases (up to ~10GB), full one-shot migration.

---

## Implementation Status

| Feature | Status |
|---------|--------|
| PostgreSQL → PostgreSQL migration | ✅ Done |
| MySQL → MySQL migration | ✅ Done |
| MySQL → PostgreSQL migration | ✅ Done |
| PostgreSQL → MySQL migration | ✅ Done |
| Schema diff + apply | ✅ Done |
| Cross-DB schema translation | ✅ Done |
| Cross-DB data migration (batched SELECT/INSERT) | ✅ Done |
| Same-DB PG data migration (`pg-copy-streams` workers) | ✅ Done |
| Custom query migration (PG source → any dest) | ✅ Done |
| Row-count validation mode | ✅ Done |
| File + console logging (TeeLogger) | ✅ Done |
| Connection retry with backoff | ✅ Done |
| MSSQL support (all 5 pairs) | ✅ Done |
| Snowflake support | ⬜ Planned (v3) |

### Status by Pair

A **Pair** is one directional migration route, and is the unit of completion. A Pair is
**Done** when implemented and covered by automated tests against mocks — running against a
live database instance is not required (see `CONTEXT.md`).

| Source ↓ / Destination → | PostgreSQL | MySQL | MSSQL | Snowflake |
|--------------------------|-----------|-------|-------|-----------|
| **PostgreSQL**           | ✅ Done   | ✅ Done | ✅ Done | ⬜ Planned |
| **MySQL**                | ✅ Done   | ✅ Done | ✅ Done | ⬜ Planned |
| **MSSQL**                | ✅ Done   | ✅ Done | ✅ Done | ⬜ Planned |
| **Snowflake**            | ⬜ Planned | ⬜ Planned | ⬜ Planned | ⬜ Planned |

Nine Pairs Done, seven Planned.

### Test coverage

`npm run test:coverage`. Thresholds in `vitest.config.ts` are pinned to the measured floor
so the build stays green and ratchets upward; the target is 80%.

| Area | Statements | Note |
|------|-----------|------|
| Translation layer (base + type maps) | 98.0% | Every type map at 100% |
| MSSQL surface (all files across its 5 Pairs) | 81.0% | Clears the 80% target |
| Application use cases + services | 74.6% | `migrate-query.use-case.ts` at 0% |
| MySQL surface | 68.6% | |
| Data migration | 68.4% | `cross-db-data-migrator.ts`, `table-copy.worker.ts` at 0% |
| PostgreSQL surface | 63.7% | |
| **`presentation/cli`** | **4.5%** | `cli.ts` 0%, `prompt.ts` 6.6% — the dominant global drag |
| **Global** | **55.8%** | |

The lowest-coverage files are those that wrap real I/O — connection adapters, the worker
thread, and the interactive CLI — which mocks cover poorly. Raising the global figure
means either testing `prompt.ts` directly (419 uncovered statements between it and
`cli.ts`, the single biggest win available) or accepting these as excluded.

---

## Technical Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Schema introspection (PG) | `information_schema` + `pg_catalog` | SQL-standard for tables/columns/constraints; pg_catalog for indexes and sequences |
| Schema introspection (MySQL) | `information_schema` + `SHOW INDEXES` | MySQL exposes full schema metadata via information_schema |
| Data transfer (PG→PG) | `COPY TO/FROM` via `pg-copy-streams` | 5-10x faster than batch INSERT for bulk data |
| Data transfer (MySQL→MySQL) | Batched SELECT + INSERT (`BATCH_SIZE=500`) | No COPY equivalent; sequential per table |
| Data transfer (cross-engine) | `CrossDbDataMigrator` — batched SELECT + INSERT | Supports MySQL↔PostgreSQL; no worker threads, sequential per table |
| Worker strategy (PG→PG only) | `worker_threads`, max 4 workers | Diminishing returns past 4 concurrent COPY streams |
| Table distribution | Sort by row count desc, round-robin across workers | Spreads large tables evenly |
| FK handling (PG) | Disable/re-enable triggers (`DISABLE TRIGGER ALL`) | Avoids topological sort, standard pg bulk-load approach |
| FK handling (MySQL) | `SET FOREIGN_KEY_CHECKS = 0/1` | MySQL equivalent of trigger disabling |
| Schema introspection (MSSQL) | `INFORMATION_SCHEMA` + `sys.*` catalog views | `sys.indexes/index_columns` for indexes; `COLUMNPROPERTY` for IDENTITY flag; `sys.partitions` for row estimates |
| FK handling (MSSQL) | `ALTER TABLE [t] NOCHECK CONSTRAINT ALL` / `WITH CHECK CHECK CONSTRAINT ALL` | MSSQL equivalent of trigger disabling; applies per table |
| Data transfer (MSSQL→MSSQL) | Batched SELECT + INSERT (`BATCH_SIZE=500`) with IDENTITY_INSERT | MSSQL OFFSET/FETCH pagination; IDENTITY_INSERT ON/OFF per table |
| Data transfer (MSSQL cross-DB) | `MssqlCrossDbDataMigrator` — batched SELECT + INSERT | Handles MSSQL↔PG and MSSQL↔MySQL; IDENTITY detection for MSSQL destinations |
| Identifier quoting (MSSQL) | `[bracketed]` syntax | MSSQL standard; avoids conflicts with reserved keywords |
| MSSQL sequence reset | `DBCC CHECKIDENT ('[t]', RESEED, value)` | MSSQL equivalent of PG `setval()` / MySQL `AUTO_INCREMENT` |
| Transactions | Per-table (not global) | Global tx impractical for multi-GB, would hold locks too long |
| Cross-DB translation | `CrossDbSchemaTranslator` base class + subclasses | Normalised type lookup with precision-suffix propagation |
| CLI prompts | `readline/promises` (built-in) | No extra dependency needed |
| Test runner | Vitest | Lighter than Jest for TypeScript projects |
| Logging | `TeeLogger` wrapping `ConsoleLogger` + `FileLogger` | Writes to both console and timestamped file per run |
| Connection reliability | `retryWithBackoff` (3 attempts, 1s base delay) | Handles transient startup failures |

---

## Architecture

Built with **hexagonal architecture** — domain logic is pure TypeScript with no I/O; all database interactions go through port interfaces.

### Layer overview

```
src/
├── domain/           # Pure types, ports (interfaces), errors — no I/O
├── application/      # Use cases and MigrationOrchestrator
├── infrastructure/   # Concrete adapters (pg, mysql, translators, migrators)
└── presentation/     # CLI prompts and entry point
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

### DatabaseAdapterRegistry

`DatabaseAdapterRegistry` (`src/infrastructure/database/registry.ts`) maps a `DatabaseType` to a `DatabaseAdapterSet`, and separately tracks cross-DB translator and migrator factories.

```
registry.register(DatabaseType.POSTGRES, new PgAdapterSet())
registry.register(DatabaseType.MYSQL, new MysqlAdapterSet())

registry.registerTranslator(MYSQL, POSTGRES, () => new MysqlToPostgresTranslator())
registry.registerTranslator(POSTGRES, MYSQL, () => new PostgresToMysqlTranslator())

registry.registerDataMigrator(MYSQL, POSTGRES, () => new CrossDbDataMigrator())
registry.registerDataMigrator(POSTGRES, MYSQL, () => new CrossDbDataMigrator())
```

`getTranslator(source, dest)` returns `PassthroughSchemaTranslator` when source === dest, otherwise resolves from the translator registry. `getDataMigrator(source, dest)` resolves from the migrator registry first, then falls back to same-engine migrators.

### Cross-DB schema translation

`CrossDbSchemaTranslator` (`src/infrastructure/database/translation/cross-db-schema-translator.ts`) is the abstract base class. It performs:
1. Exact type match (handles special cases like `tinyint(1)`)
2. Normalised base-name lookup (strips precision suffix)
3. Precision-suffix propagation to target types that support it (`numeric`, `decimal`, `varchar`, etc.)
4. Fallback to original type for unknowns

Concrete subclasses:
- `MysqlToPostgresTranslator` — uses `MYSQL_TO_POSTGRES_TYPE_MAP`
- `PostgresToMysqlTranslator` — uses `POSTGRES_TO_MYSQL_TYPE_MAP`
- `MssqlToPostgresTranslator` — uses `MSSQL_TO_POSTGRES_TYPE_MAP`
- `MssqlToMysqlTranslator` — uses `MSSQL_TO_MYSQL_TYPE_MAP`
- `PostgresToMssqlTranslator` — uses `POSTGRES_TO_MSSQL_TYPE_MAP`
- `MysqlToMssqlTranslator` — uses `MYSQL_TO_MSSQL_TYPE_MAP`

Default-value translation is handled by `DefaultValueTranslator` (injected into each subclass).

---

## Dependencies

```json
{
  "dependencies": {
    "pg": "^8.x",
    "pg-copy-streams": "^7.x",
    "mysql2": "^3.x",
    "mssql": "^12.x"
  },
  "devDependencies": {
    "typescript": "^6.x",
    "ts-node": "^10.x",
    "ts-node-dev": "^2.x",
    "@types/node": "^25.x",
    "@types/pg": "^8.x",
    "@types/pg-copy-streams": "^1.x",
    "vitest": "^4.x"
  }
}
```

### Future dependencies (not yet added)

| Database | Driver |
|----------|--------|
| Snowflake | `snowflake-sdk` |

`@vitest/coverage-v8` is installed as a devDependency for `npm run test:coverage`.

---

## Project Structure

```
src/
├── index.ts
├── domain/
│   ├── types/
│   │   ├── connection.types.ts         # DatabaseType enum, ConnectionConfig
│   │   ├── schema.types.ts             # DatabaseSchema, TableSchema, ColumnSchema, …
│   │   ├── migration.types.ts          # SchemaDiff, MigrationResult, TableMigrationResult
│   │   └── worker.types.ts             # WorkerPayload, WorkerMessage
│   ├── errors/
│   │   └── migration.errors.ts         # Custom error classes (UnsupportedDatabaseError, etc.)
│   └── ports/
│       ├── database.port.ts            # IDatabaseConnection
│       ├── schema-inspector.port.ts    # ISchemaInspector
│       ├── schema-synchronizer.port.ts # ISchemaSynchronizer
│       ├── schema-translator.port.ts   # ISchemaTranslator
│       ├── data-migrator.port.ts       # IDataMigrator
│       ├── query-analyzer.port.ts      # IQueryAnalyzer
│       └── logger.port.ts              # ILogger
├── application/
│   ├── use-cases/
│   │   ├── create-database.use-case.ts
│   │   ├── compare-schemas.use-case.ts
│   │   ├── sync-schema.use-case.ts
│   │   ├── migrate-data.use-case.ts
│   │   ├── migrate-query.use-case.ts   # Custom SQL → new table
│   │   └── validate-counts.use-case.ts # Row-count comparison
│   └── services/
│       ├── migration-orchestrator.service.ts
│       └── table-migration-planner.service.ts  # Topological FK sort → TableMigrationPlan
├── infrastructure/
│   ├── database/
│   │   ├── registry.ts                 # DatabaseAdapterRegistry + PassthroughSchemaTranslator
│   │   ├── pg/
│   │   │   ├── pg-connection.adapter.ts
│   │   │   ├── pg-schema-inspector.adapter.ts
│   │   │   ├── pg-schema-synchronizer.adapter.ts
│   │   │   ├── pg-schema-translator.adapter.ts  # Passthrough (PG→PG)
│   │   │   ├── pg-query-analyzer.adapter.ts
│   │   │   ├── postgres-to-mysql-translator.adapter.ts
│   │   │   ├── postgres-to-mssql-translator.adapter.ts
│   │   │   └── pg-adapter-set.ts
│   │   ├── mysql/
│   │   │   ├── mysql-connection.adapter.ts
│   │   │   ├── mysql-schema-inspector.adapter.ts
│   │   │   ├── mysql-schema-synchronizer.adapter.ts
│   │   │   ├── mysql-query-analyzer.adapter.ts
│   │   │   ├── mysql-to-postgres-translator.adapter.ts
│   │   │   ├── mysql-to-mssql-translator.adapter.ts
│   │   │   └── mysql-adapter-set.ts
│   │   ├── mssql/
│   │   │   ├── mssql-connection.adapter.ts
│   │   │   ├── mssql-schema-inspector.adapter.ts
│   │   │   ├── mssql-schema-synchronizer.adapter.ts
│   │   │   ├── mssql-query-analyzer.adapter.ts
│   │   │   ├── mssql-to-postgres-translator.adapter.ts
│   │   │   ├── mssql-to-mysql-translator.adapter.ts
│   │   │   └── mssql-adapter-set.ts
│   │   └── translation/
│   │       ├── cross-db-schema-translator.ts   # Abstract base class
│   │       ├── default-value.translator.ts
│   │       └── type-maps/
│   │           ├── mysql-to-postgres.type-map.ts
│   │           ├── postgres-to-mysql.type-map.ts
│   │           ├── mssql-to-postgres.type-map.ts
│   │           ├── mssql-to-mysql.type-map.ts
│   │           ├── postgres-to-mssql.type-map.ts
│   │           └── mysql-to-mssql.type-map.ts
│   ├── migration/
│   │   ├── pg-data-migrator.adapter.ts          # PG→PG via pg-copy-streams workers
│   │   ├── mysql-data-migrator.adapter.ts        # MySQL→MySQL via batched SELECT/INSERT
│   │   ├── cross-db-data-migrator.ts             # MySQL↔PG via batched SELECT/INSERT
│   │   ├── mssql-data-migrator.adapter.ts        # MSSQL→MSSQL via batched SELECT/INSERT
│   │   ├── mssql-cross-db-data-migrator.ts       # All MSSQL↔PG and MSSQL↔MySQL pairs
│   │   ├── worker-pool.ts
│   │   └── table-copy.worker.ts
│   └── logging/
│       ├── console-logger.adapter.ts
│       ├── file-logger.adapter.ts
│       └── tee-logger.adapter.ts
├── presentation/
│   └── cli/
│       ├── prompt.ts
│       └── cli.ts
└── shared/
    └── utils.ts                # escapeIdentifier, formatDuration, chunkArray, resolveWorkerPath, retryWithBackoff

tests/
├── unit/
│   ├── domain/
│   │   └── errors.test.ts
│   ├── application/
│   │   ├── compare-schemas.use-case.test.ts
│   │   ├── create-database.use-case.test.ts
│   │   ├── migrate-data.use-case.test.ts
│   │   ├── migration-orchestrator.service.test.ts
│   │   ├── sync-schema.use-case.test.ts
│   │   ├── table-migration-planner.service.test.ts
│   │   └── validate-counts.use-case.test.ts
│   └── infrastructure/
│       ├── database-adapter-registry.test.ts
│       ├── mysql-data-migrator.test.ts
│       ├── pg-data-migrator.test.ts
│       ├── pg-schema-inspector.test.ts
│       ├── pg-schema-synchronizer.test.ts
│       ├── pg-schema-translator.test.ts
│       ├── worker-pool.test.ts
│       ├── mysql/
│       │   ├── mysql-schema-inspector.test.ts
│       │   ├── mysql-schema-synchronizer.test.ts
│       │   ├── mysql-to-postgres-translator.test.ts
│       │   └── mysql-to-mssql-translator.test.ts
│       ├── mssql/
│       │   ├── mssql-connection.test.ts
│       │   ├── mssql-schema-inspector.test.ts
│       │   ├── mssql-schema-synchronizer.test.ts
│       │   ├── mssql-to-postgres-translator.test.ts
│       │   └── mssql-to-mysql-translator.test.ts
│       ├── pg/
│       │   └── postgres-to-mssql-translator.test.ts
│       ├── translation/
│       │   ├── cross-db-schema-translator.test.ts
│       │   ├── default-value-translator.test.ts
│       │   ├── mysql-to-postgres-type-map.test.ts
│       │   ├── postgres-to-mysql-type-map.test.ts
│       │   ├── mssql-to-postgres-type-map.test.ts
│       │   ├── mssql-to-mysql-type-map.test.ts
│       │   ├── postgres-to-mssql-type-map.test.ts
│       │   └── mysql-to-mssql-type-map.test.ts
│       ├── mssql-data-migrator.test.ts
│       ├── mssql-cross-db-data-migrator.test.ts
│       └── presentation/
│           └── prompt.test.ts
├── integration/
│   └── README.md
└── helpers/
    └── mock-database.ts
```

---

## Migration Flow (MigrationOrchestrator)

1. **Resolve adapters** — `registry.get(source.type)`, `registry.get(dest.type)`, `registry.getTranslator(source, dest)`
2. **Validate connections** — connect to source + admin DB with retry backoff
3. **Create database** — `ensureDatabase()` on the admin connection; creates dest DB if missing
4. **Connect to destination** — connect to actual dest DB with retry backoff
5. **Inspect & diff schemas** — source inspector + dest inspector; `synchronizer.diff()`
6. **Apply schema diff** — tables, columns, constraints (no indexes yet); types run through `ISchemaTranslator`
7. **Disable FK checks / triggers** — `synchronizer.disableTriggers()` (PG: `DISABLE TRIGGER ALL`; MySQL: `SET FOREIGN_KEY_CHECKS=0`)
8. **Plan table migration order** — `TableMigrationPlanner.plan(tables, rowEstimates)` performs a topological sort on FK dependencies, producing a `TableMigrationPlan` with:
   - `loadOrder` — tables in dependency-safe copy order, ties broken by row count desc (largest tables first)
   - `cleanupOrder` — reverse of loadOrder, used for destination truncation
   - `levels` — topological levels (tables in the same level have no mutual dependencies)
   - `cyclicTables` — tables involved in FK cycles, appended at the end with a warning
9. **Migrate data** — `registry.getDataMigrator(source, dest)` selects the right migrator, called with the `TableMigrationPlan`:
   - PG→PG: `WorkerPool` + `pg-copy-streams` (parallel, up to 4 workers)
   - MySQL→MySQL: `MysqlDataMigrator` (sequential, batched SELECT/INSERT)
   - MySQL↔PG: `CrossDbDataMigrator` (sequential, batched SELECT/INSERT, batch size 500)
   - MSSQL→MSSQL: `MssqlDataMigrator` (sequential, batched SELECT/INSERT, NOCHECK/CHECK constraints)
   - MSSQL↔PG / MSSQL↔MySQL: `MssqlCrossDbDataMigrator` (sequential, batched, IDENTITY_INSERT handling)
10. **Re-enable FK checks / triggers** — `synchronizer.enableTriggers()`
11. **Create indexes** — deferred from step 6 for bulk-load performance
12. **Reset sequences** — PG: query source `last_value`, call `setval()` on destination. MySQL: `ALTER TABLE … AUTO_INCREMENT = <value>`.

### Error handling

- **Schema sync failure**: single transaction rolls back all schema changes; migration aborts
- **Data migration partial failure**: failed tables are reported; other tables continue; destination is left in partial state
- **Index creation failure**: caught per-index, logged as warning; migration continues

---

## CLI App Modes

```
npm start
```

1. **migrate / full** — full schema + data migration between source and destination
2. **migrate / query** — run a custom SQL query on the source, land results as a new table on the destination (PostgreSQL source only)
3. **validate** — compare row counts between two databases without migrating anything

After a `migrate` run, the user is optionally prompted to run row-count validation.

---

## Key Interfaces

### `TableMigrationPlan`
```ts
interface TableMigrationPlan {
  loadOrder: string[];      // tables in safe FK dependency order, largest first within each level
  cleanupOrder: string[];   // reverse of loadOrder — used to truncate destination tables
  levels: string[][];       // topological levels; tables in the same level have no mutual FK deps
  cyclicTables: string[];   // tables in FK cycles; appended at end of loadOrder with a warning
}
```

Produced by `TableMigrationPlanner.plan(tables, rowEstimates)` and consumed by all `IDataMigrator` implementations.

### `IDatabaseConnection`
```ts
connect(): Promise<void>
query<T>(sql: string, params?: unknown[]): Promise<T[]>
getClient(): Promise<PoolClient>   // PG only — for COPY streams
end(): Promise<void>
```

### `ISchemaInspector`
```ts
inspect(connection: IDatabaseConnection, schemaName?: string): Promise<DatabaseSchema>
getTableRowEstimates(connection: IDatabaseConnection): Promise<Map<string, number>>
```

### `ISchemaSynchronizer`
```ts
diff(source: DatabaseSchema, target: DatabaseSchema): SchemaDiff
apply(connection: IDatabaseConnection, diff: SchemaDiff): Promise<void>
disableTriggers(connection: IDatabaseConnection, tables: string[]): Promise<void>
enableTriggers(connection: IDatabaseConnection, tables: string[]): Promise<void>
createIndexes(connection: IDatabaseConnection, diff: SchemaDiff): Promise<void>
resetSequences(source: IDatabaseConnection, dest: IDatabaseConnection, sequences: SequenceSchema[], tables?: TableSchema[]): Promise<void>
ensureDatabase(adminConnection: IDatabaseConnection, dbName: string): Promise<boolean>
```

### `IDataMigrator`
```ts
migrate(
  sourceConfig: ConnectionConfig,
  destConfig: ConnectionConfig,
  plan: TableMigrationPlan,       // load/cleanup order computed by TableMigrationPlanner
  workerCount: number,
  rowEstimates?: Map<string, number>,
  onProgress?: MigrationProgressCallback
): Promise<MigrationResult>
```

### `ISchemaTranslator`
```ts
translateColumnType(sourceType: string, sourceDbType: DatabaseType, destDbType: DatabaseType): string
translateDefaultValue(defaultExpr: string, sourceDbType: DatabaseType, destDbType: DatabaseType): string
translateConstraint(constraint: ConstraintSchema, sourceDbType: DatabaseType, destDbType: DatabaseType): ConstraintSchema
```

### `DatabaseAdapterRegistry`
```ts
register(type: DatabaseType, adapters: DatabaseAdapterSet): void
registerTranslator(source: DatabaseType, dest: DatabaseType, factory: () => ISchemaTranslator): void
registerDataMigrator(source: DatabaseType, dest: DatabaseType, factory: () => IDataMigrator): void
get(type: DatabaseType): DatabaseAdapterSet           // throws UnsupportedDatabaseError
getTranslator(source: DatabaseType, dest: DatabaseType): ISchemaTranslator
getDataMigrator(source: DatabaseType, dest: DatabaseType): IDataMigrator
has(type: DatabaseType): boolean
listTypes(): DatabaseType[]
```

---

## Type Maps

### MySQL → PostgreSQL

| MySQL | PostgreSQL |
|-------|-----------|
| `tinyint(1)` | `boolean` |
| `tinyint` | `smallint` |
| `smallint` | `smallint` |
| `mediumint` | `integer` |
| `int` / `integer` | `integer` |
| `bigint` | `bigint` |
| `float` | `real` |
| `double` | `double precision` |
| `decimal` / `numeric` | `numeric` (precision preserved) |
| `char` | `char` |
| `varchar` | `varchar` (length preserved) |
| `binary` / `varbinary` | `bytea` |
| `tinyblob` / `blob` / `mediumblob` / `longblob` | `bytea` |
| `tinytext` / `text` / `mediumtext` / `longtext` | `text` |
| `date` | `date` |
| `time` | `time` |
| `datetime` | `timestamp without time zone` |
| `timestamp` | `timestamp with time zone` |
| `year` | `integer` |
| `json` | `jsonb` |
| `enum` / `set` | `text` |
| `bit` | `bit` |

### PostgreSQL → MySQL

Reverse mappings defined in `postgres-to-mysql.type-map.ts`.

### MSSQL → PostgreSQL

| MSSQL | PostgreSQL |
|-------|-----------|
| `nvarchar` | `varchar` (length preserved) |
| `nvarchar(max)` / `ntext` | `text` |
| `nchar` | `char` |
| `bit` | `boolean` |
| `int` | `integer` |
| `bigint` | `bigint` |
| `smallint` | `smallint` |
| `tinyint` | `smallint` |
| `decimal` / `numeric` | `numeric` (precision preserved) |
| `money` / `smallmoney` | `numeric(19,4)` |
| `float` | `double precision` |
| `real` | `real` |
| `datetime` / `datetime2` / `smalldatetime` | `timestamp without time zone` |
| `datetimeoffset` | `timestamp with time zone` |
| `date` | `date` |
| `time` | `time` |
| `timestamp` / `rowversion` | `bytea` (binary row-version, not a datetime) |
| `uniqueidentifier` | `uuid` |
| `varbinary(max)` / `image` | `bytea` |
| `xml` | `xml` |
| `char` | `char` |
| `varchar` | `varchar` |

### MSSQL → MySQL

| MSSQL | MySQL |
|-------|-------|
| `nvarchar` | `varchar` (length preserved) |
| `nvarchar(max)` / `ntext` | `longtext` |
| `nchar` | `char` |
| `bit` | `tinyint(1)` |
| `int` | `int` |
| `bigint` | `bigint` |
| `smallint` | `smallint` |
| `tinyint` | `tinyint` |
| `decimal` / `numeric` | `decimal` (precision preserved) |
| `money` / `smallmoney` | `decimal(19,4)` |
| `float` | `double` |
| `real` | `float` |
| `datetime` / `smalldatetime` | `datetime` |
| `datetime2` | `datetime` |
| `datetimeoffset` | `datetime` |
| `date` | `date` |
| `time` | `time` |
| `timestamp` / `rowversion` | `binary(8)` |
| `uniqueidentifier` | `char(36)` |
| `varbinary(max)` / `image` | `longblob` |
| `xml` | `longtext` |

### PostgreSQL → MSSQL

| PostgreSQL | MSSQL |
|-----------|-------|
| `boolean` | `bit` |
| `integer` / `int4` | `int` |
| `bigint` / `int8` | `bigint` |
| `smallint` / `int2` | `smallint` |
| `numeric` / `decimal` | `decimal` (precision preserved) |
| `double precision` | `float` |
| `real` | `real` |
| `varchar` / `character varying` | `nvarchar` (length preserved) |
| `text` | `nvarchar(max)` |
| `char` / `character` | `nchar` |
| `bytea` | `varbinary(max)` |
| `timestamp` / `timestamp without time zone` | `datetime2` |
| `timestamp with time zone` | `datetimeoffset` |
| `date` | `date` |
| `time` | `time` |
| `uuid` | `uniqueidentifier` |
| `jsonb` / `json` | `nvarchar(max)` |
| `xml` | `xml` |
| `serial` | `int` |
| `bigserial` | `bigint` |

### MySQL → MSSQL

| MySQL | MSSQL |
|-------|-------|
| `tinyint(1)` | `bit` |
| `tinyint` | `tinyint` |
| `smallint` | `smallint` |
| `mediumint` / `int` / `integer` | `int` |
| `bigint` | `bigint` |
| `float` | `float` |
| `double` | `float` |
| `decimal` / `numeric` | `decimal` (precision preserved) |
| `char` | `nchar` |
| `varchar` | `nvarchar` (length preserved) |
| `tinytext` / `text` / `mediumtext` / `longtext` | `nvarchar(max)` |
| `binary` / `varbinary` | `varbinary` |
| `tinyblob` / `blob` / `mediumblob` / `longblob` | `varbinary(max)` |
| `date` | `date` |
| `time` | `time` |
| `datetime` | `datetime2` |
| `timestamp` | `datetimeoffset` |
| `year` | `int` |
| `json` | `nvarchar(max)` |
| `enum` / `set` | `nvarchar(255)` |

---

## Future Database Support Roadmap

### Snowflake — current state and remaining work

Snowflake is engine #4. It is built on the existing **direct-pair** design — see
[ADR-0001](adr/0001-direct-pair-type-translation.md) — so it costs six new type maps and
six new translators, not two.

#### What exists today

| Item | State |
|------|-------|
| `DatabaseType.SNOWFLAKE` in `domain/types/connection.types.ts` | ✅ present |
| CLI env-type parsing (`snowflake` → `DatabaseType.SNOWFLAKE`, `prompt.ts`) | ✅ present |
| "Planned for v3" message in `UnsupportedDatabaseError` | ✅ present — selecting Snowflake fails cleanly, no crash |
| `src/infrastructure/database/snowflake/README.md` | ✅ stub only |
| Everything else | ⬜ nothing — no adapters, no type maps, no tests, no `snowflake-sdk` dependency |

#### Pairs to deliver — 7

One same-engine plus six cross-engine:

`SF→SF`, `SF→PG`, `PG→SF`, `SF→MySQL`, `MySQL→SF`, `SF→MSSQL`, `MSSQL→SF`

#### Blocking design gaps

These must be resolved before adapter work starts — each one breaks an assumption the
other three engines share.

1. **`ConnectionConfig` has no Snowflake fields.** Snowflake connects by `account`,
   `warehouse`, `role` and optional `schema` — none of which exist on the current shape:

   ```ts
   interface ConnectionConfig {
     type: DatabaseType; host: string; port: number;
     user: string; password: string; database: string;
   }
   ```

   This is a **domain type change affecting every engine**, plus the CLI prompt flow and
   the `{ROLE}_{DBTYPE}_{FIELD}` env convention. Decide the shape first — an optional
   engine-specific bag versus widening the interface — because every adapter reads it.

2. **No enforced foreign keys.** Snowflake accepts FK syntax but does not enforce it, so
   `disableTriggers()` / `enableTriggers()` become no-ops. `TableMigrationPlanner`'s
   topological sort still matters for a Snowflake *source* (the destination may enforce),
   but is inert for a Snowflake destination.

3. **No indexes.** `createIndexes()` is a no-op — micro-partitions, not indexes. Index
   metadata inspected from a source engine has nowhere to land.

4. **No sequences.** `AUTOINCREMENT`/`IDENTITY` exist but there is no `setval()` or
   `DBCC CHECKIDENT` equivalent; reseeding requires recreating the column's sequence.
   `resetSequences()` is effectively a no-op, which means round-tripping a PG source
   through Snowflake and back loses sequence position.

5. **Bulk load is staged, not batched.** The only performant path is `PUT` a local CSV to
   an internal stage then `COPY INTO`. Batched `INSERT` works but is an order of magnitude
   slower and is not viable at the 10GB target. This does not fit the
   `CrossDbDataMigrator` batched SELECT/INSERT shape, so Snowflake destinations need their
   own migrator that materialises to CSV first.

#### Checklist

- [ ] Resolve the `ConnectionConfig` shape for `account` / `warehouse` / `role` (blocks everything below)
- [ ] Add `snowflake-sdk` to `dependencies`
- [ ] Extend CLI prompts and `.env.example` for the new connection fields
- [ ] `snowflake-connection.adapter.ts` — `IDatabaseConnection`
- [ ] `snowflake-schema-inspector.adapter.ts` — `INFORMATION_SCHEMA` + `SHOW PRIMARY KEYS` / `SHOW IMPORTED KEYS`
- [ ] `snowflake-schema-synchronizer.adapter.ts` — no-op `createIndexes` / `resetSequences` / trigger control, documented as deliberate
- [ ] `snowflake-query-analyzer.adapter.ts` — `IQueryAnalyzer`
- [ ] 6 type maps: `snowflake-to-{postgres,mysql,mssql}` and `{postgres,mysql,mssql}-to-snowflake`
- [ ] 6 translators extending `CrossDbSchemaTranslator`
- [ ] `snowflake-data-migrator.adapter.ts` — `PUT` + `COPY INTO` staged load (SF→SF)
- [ ] Cross-engine migrator handling staged load for Snowflake destinations
- [ ] `snowflake-adapter-set.ts`
- [ ] Register all of the above in `cli.ts`
- [ ] Unit tests for every adapter and type map — a Pair is not Done without them
- [ ] Remove the `SNOWFLAKE: 'v3'` entry from `UnsupportedDatabaseError`'s `versionMap` once registered
- [ ] Update `README.md`, `CLAUDE.md`, `CONTEXT.md` and the Status-by-Pair table

#### Type map (Snowflake → PostgreSQL) — starting point

| Snowflake | PostgreSQL |
|-----------|-----------|
| `NUMBER(38,0)` | `BIGINT` |
| `NUMBER(p,s)` | `NUMERIC(p,s)` |
| `FLOAT` | `DOUBLE PRECISION` |
| `VARIANT` / `ARRAY` / `OBJECT` | `JSONB` |
| `TIMESTAMP_NTZ` | `TIMESTAMP WITHOUT TIME ZONE` |
| `TIMESTAMP_TZ` / `TIMESTAMP_LTZ` | `TIMESTAMP WITH TIME ZONE` |
| `BINARY` | `BYTEA` |

The remaining five maps are unwritten.

### Adding a new database: checklist

1. Add the type to `DatabaseType` enum in `domain/types/connection.types.ts`
2. Create `infrastructure/database/<engine>/` directory
3. Implement `IDatabaseConnection`
4. Implement `ISchemaInspector`
5. Implement `ISchemaSynchronizer` (including `disableTriggers`, `enableTriggers`, `createIndexes`, `resetSequences`, `ensureDatabase`)
6. Implement `IDataMigrator` (same-engine)
7. Create type-map file(s) in `infrastructure/database/translation/type-maps/`
8. Implement `ISchemaTranslator` subclass(es) extending `CrossDbSchemaTranslator`
9. Implement `CrossDbDataMigrator`-compatible migrator if needed, or register `CrossDbDataMigrator` for the pair
10. Create `<engine>-adapter-set.ts`
11. Register in `cli.ts`: `registry.register(...)`, `registry.registerTranslator(...)`, `registry.registerDataMigrator(...)`
12. Add driver package to `dependencies`
13. Add unit tests for all new adapters
14. Add integration test with Docker container

---

## Known Limitations

- **Public schema only (PostgreSQL)**: Targets `public` schema. Other schemas are ignored.
- **MySQL enums**: Migrated as `text`; enum values are not preserved as PostgreSQL `ENUM` types.
- **MySQL sequences**: MySQL has no standalone sequences, so the `SequenceSchema[]` argument is ignored. `resetSequences()` is *not* a no-op — it replays each table's `AUTO_INCREMENT` value via `ALTER TABLE … AUTO_INCREMENT`.
- **Custom query migration**: PostgreSQL source **and** destination only. `MigrateQueryUseCase` streams via `COPY … TO STDOUT` / `COPY … FROM STDIN` and casts both connections to `PgConnection`; there is no portable equivalent for MySQL or MSSQL. `MssqlQueryAnalyzer` and `MysqlQueryAnalyzer` are therefore unreachable dead code (see issue #4).
- **MSSQL schema**: Only `dbo` schema is supported. Tables in other schemas are not introspected.
- **MSSQL `timestamp`/`rowversion`**: These are binary row-version counters (not datetime); mapped to `bytea`/`binary(8)` in cross-DB migrations.
- **Same-engine worker parallelism**: Only PG→PG uses worker threads. MySQL→MySQL and cross-engine migrations process tables sequentially.
- **No resume/retry**: Partial migration state is reported but not automatically recovered.
- **No dry-run mode**: All changes are applied directly. Use a staging destination to preview.

### Open bugs

- **[#4](https://github.com/EduardoPetrini/nodejs-movy-data/issues/4) — `MssqlQueryAnalyzer` and `MysqlQueryAnalyzer` are unreachable.** Both are implemented and wired into their adapter sets, but query migration is PostgreSQL-only by construction, so neither can run. Open question: implement portable query migration, or delete them. `needs-triage`.

### Fixed in this pass

- **[#3](https://github.com/EduardoPetrini/nodejs-movy-data/issues/3) — MSSQL reseed assumed an identity column named `id`.** `resetSequences()` now queries `MAX()` on the column found via `column.autoIncrement` instead of a hardcoded `[id]`. Regression tests added.
- **[#5](https://github.com/EduardoPetrini/nodejs-movy-data/issues/5) — query migration crashed on a non-PostgreSQL destination.** The CLI guard checked only the source while `streamData()` casts both connections; it now rejects any non-PostgreSQL source *or* destination. The guard itself is still untested — `cli.ts` sits at 0% coverage.

---

## Key Gotchas

- **Worker ts-node**: Workers don't inherit ts-node loader. Pass `execArgv: ['-r', 'ts-node/register']` in development.
- **CREATE DATABASE**: Cannot run inside a transaction — use autocommit.
- **Sequence reset**: `COPY` doesn't advance sequences. Must query `last_value` from source and `setval()` on destination.
- **COPY backpressure**: Use `stream.pipeline()` from `stream/promises`.
- **TRUNCATE before COPY/INSERT**: Each migrator truncates the target table before copying. `RESTRICT` (not `CASCADE`) for PG; plain `TRUNCATE TABLE` for MySQL (FK checks already disabled).
- **Index creation deferred**: Apply table/column/constraint DDL first; create indexes after data load.
- **MySQL DDL auto-commits**: MySQL DDL statements (`CREATE TABLE`, `ALTER TABLE`) implicitly commit. Statements are applied sequentially, not in a transaction.
- **MySQL TEXT/BLOB in indexes**: Require a prefix length (e.g., `col(255)`). `MysqlSchemaSynchronizer.buildConstraintDef()` handles this automatically.
- **MSSQL IDENTITY_INSERT**: Only one table can have `SET IDENTITY_INSERT ON` at a time. All migrators process tables sequentially, so this is safe.
- **MSSQL `nvarchar(max)` type maps**: The precision propagation regex only matches digits, so `(max)` requires an explicit exact-match entry in the type map.
- **MSSQL positional params**: The `mssql` driver uses named params (`@p0`, `@p1`). `MssqlConnection.query()` automatically converts positional `?` placeholders to named inputs.
- **Vitest + CommonJS**: Set `pool: 'forks'` in `vitest.config.ts`.
- **Registry initialisation order**: All adapter sets must be registered before the orchestrator is constructed.
