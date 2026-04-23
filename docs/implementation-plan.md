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
| MSSQL support | ⬜ Planned (v3) |
| Snowflake support | ⬜ Planned (v3) |

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

Default-value translation is handled by `DefaultValueTranslator` (injected into each subclass).

---

## Dependencies

```json
{
  "dependencies": {
    "pg": "^8.x",
    "pg-copy-streams": "^7.x",
    "mysql2": "^3.x"
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
| MSSQL | `mssql` (wraps `tedious`) |
| Snowflake | `snowflake-sdk` |

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
│       └── migration-orchestrator.service.ts
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
│   │   │   └── pg-adapter-set.ts
│   │   ├── mysql/
│   │   │   ├── mysql-connection.adapter.ts
│   │   │   ├── mysql-schema-inspector.adapter.ts
│   │   │   ├── mysql-schema-synchronizer.adapter.ts
│   │   │   ├── mysql-query-analyzer.adapter.ts
│   │   │   ├── mysql-to-postgres-translator.adapter.ts
│   │   │   └── mysql-adapter-set.ts
│   │   └── translation/
│   │       ├── cross-db-schema-translator.ts   # Abstract base class
│   │       ├── default-value.translator.ts
│   │       └── type-maps/
│   │           ├── mysql-to-postgres.type-map.ts
│   │           └── postgres-to-mysql.type-map.ts
│   ├── migration/
│   │   ├── pg-data-migrator.adapter.ts     # PG→PG via pg-copy-streams workers
│   │   ├── mysql-data-migrator.adapter.ts  # MySQL→MySQL via batched SELECT/INSERT
│   │   ├── cross-db-data-migrator.ts       # MySQL↔PG via batched SELECT/INSERT
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
│   ├── application/
│   └── infrastructure/
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
8. **Migrate data** — `registry.getDataMigrator(source, dest)` selects the right migrator:
   - PG→PG: `WorkerPool` + `pg-copy-streams` (parallel, up to 4 workers)
   - MySQL→MySQL: `MysqlDataMigrator` (sequential, batched SELECT/INSERT)
   - MySQL↔PG: `CrossDbDataMigrator` (sequential, batched SELECT/INSERT, batch size 500)
9. **Re-enable FK checks / triggers** — `synchronizer.enableTriggers()`
10. **Create indexes** — deferred from step 6 for bulk-load performance
11. **Reset sequences** — PG only; query source `last_value`, call `setval()` on destination

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
resetSequences(source: IDatabaseConnection, dest: IDatabaseConnection, sequences: SequenceSchema[]): Promise<void>
ensureDatabase(adminConnection: IDatabaseConnection, dbName: string): Promise<boolean>
```

### `IDataMigrator`
```ts
migrate(
  sourceConfig: ConnectionConfig,
  destConfig: ConnectionConfig,
  tables: string[],
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

---

## Future Database Support Roadmap

### v3: MSSQL

**Driver**: `mssql` (wraps `tedious`; supports Windows auth, Azure AD)

**Schema introspection**: `sys.tables`, `sys.columns`, `sys.indexes`, `sys.foreign_keys` + `INFORMATION_SCHEMA` views.

**Data transfer**: BCP via `mssql`'s bulk insert API; fallback to batched INSERT with `IDENTITY_INSERT ON`.

**Type map (MSSQL → PostgreSQL)**:

| MSSQL | PostgreSQL |
|-------|-----------|
| `NVARCHAR(n)` | `VARCHAR(n)` |
| `NTEXT` | `TEXT` |
| `BIT` | `BOOLEAN` |
| `DATETIME2` | `TIMESTAMP WITHOUT TIME ZONE` |
| `DATETIMEOFFSET` | `TIMESTAMP WITH TIME ZONE` |
| `MONEY` | `NUMERIC(19,4)` |
| `UNIQUEIDENTIFIER` | `UUID` |
| `IMAGE` | `BYTEA` |
| `IDENTITY(1,1)` | `GENERATED ALWAYS AS IDENTITY` |

**Special considerations**: `[bracketed]` identifiers; multi-schema support may be needed (`dbo` is default).

**Adapters to implement**:
- `infrastructure/database/mssql/mssql-connection.adapter.ts`
- `infrastructure/database/mssql/mssql-schema-inspector.adapter.ts`
- `infrastructure/database/mssql/mssql-schema-synchronizer.adapter.ts`
- `infrastructure/database/mssql/mssql-to-postgres-translator.adapter.ts`
- `infrastructure/database/mssql/mssql-adapter-set.ts`
- `infrastructure/migration/mssql-data-migrator.adapter.ts`
- `infrastructure/database/translation/type-maps/mssql-to-postgres.type-map.ts`

### v3: Snowflake

**Driver**: `snowflake-sdk` (official Snowflake Node.js driver)

**Schema introspection**: `INFORMATION_SCHEMA.TABLES/COLUMNS` + `SHOW PRIMARY KEYS` / `SHOW IMPORTED KEYS`.

**Data transfer**: `PUT` staged CSV + `COPY INTO` (only performant bulk-load path for Snowflake).

**Type map (Snowflake → PostgreSQL)**:

| Snowflake | PostgreSQL |
|-----------|-----------|
| `NUMBER(38,0)` | `BIGINT` |
| `NUMBER(p,s)` | `NUMERIC(p,s)` |
| `FLOAT` | `DOUBLE PRECISION` |
| `VARIANT` / `ARRAY` / `OBJECT` | `JSONB` |
| `TIMESTAMP_NTZ` | `TIMESTAMP WITHOUT TIME ZONE` |
| `TIMESTAMP_TZ` / `TIMESTAMP_LTZ` | `TIMESTAMP WITH TIME ZONE` |
| `BINARY` | `BYTEA` |

**Special considerations**: No traditional indexes (micro-partitions); `createIndexes()` is a no-op. No standalone sequences; `resetSequences()` is a no-op.

**Adapters to implement**:
- `infrastructure/database/snowflake/snowflake-connection.adapter.ts`
- `infrastructure/database/snowflake/snowflake-schema-inspector.adapter.ts`
- `infrastructure/database/snowflake/snowflake-schema-synchronizer.adapter.ts`
- `infrastructure/database/snowflake/snowflake-to-postgres-translator.adapter.ts`
- `infrastructure/database/snowflake/snowflake-adapter-set.ts`
- `infrastructure/migration/snowflake-data-migrator.adapter.ts`

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
- **MySQL sequences**: MySQL has no standalone sequences; `resetSequences()` is a no-op for MySQL destinations.
- **Custom query migration**: PostgreSQL source only.
- **Same-engine worker parallelism**: Only PG→PG uses worker threads. MySQL→MySQL and cross-engine migrations process tables sequentially.
- **No resume/retry**: Partial migration state is reported but not automatically recovered.
- **No dry-run mode**: All changes are applied directly. Use a staging destination to preview.

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
- **Vitest + CommonJS**: Set `pool: 'forks'` in `vitest.config.ts`.
- **Registry initialisation order**: All adapter sets must be registered before the orchestrator is constructed.
