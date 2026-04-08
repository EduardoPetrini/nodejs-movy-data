# PostgreSQL-to-PostgreSQL Data Migration Platform

## Context

Build a CLI-based data migration platform that moves data from one PostgreSQL instance to another. The user provides source and destination connection details via interactive prompts. The system creates the destination database if needed, enforces the source schema as the source of truth, then migrates data efficiently using worker threads. Target: small-to-medium databases (up to ~10GB), full one-shot migration.

---

## Technical Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Schema introspection | `information_schema` + `pg_catalog` | SQL-standard for tables/columns/constraints; pg_catalog for indexes and sequences |
| Data transfer | `COPY TO/FROM` via `pg-copy-streams` | 5-10x faster than batch INSERT for bulk data |
| Worker strategy | `worker_threads`, max 4 workers | Diminishing returns past 4 concurrent COPY streams for small-medium DBs |
| Table distribution | Sort by row count desc, round-robin across workers | Spreads large tables evenly |
| FK handling | Disable/re-enable triggers on target tables | Avoids topological sort, standard pg bulk-load approach |
| Transactions | Per-table (not global) | Global tx impractical for multi-GB, would hold locks too long |
| CLI prompts | `readline/promises` (built-in) | No extra dependency needed |
| Test runner | Vitest | Lighter than Jest for TypeScript projects |

---

## Multi-Database Architecture

### Design Principles

The platform is built with a hexagonal (ports and adapters) architecture. All database-specific logic lives behind port interfaces. A central **DatabaseAdapterRegistry** maps a `DatabaseType` discriminator to the concrete adapters for that vendor. In v1, only PostgreSQL adapters are registered. Adding a new database means implementing the port interfaces and registering them — no orchestrator or use-case changes required.

### DatabaseType Enum

Defined in `domain/types/connection.types.ts`:

```ts
enum DatabaseType {
  POSTGRES = 'postgres',
  MYSQL = 'mysql',
  MSSQL = 'mssql',
  SNOWFLAKE = 'snowflake',
}
```

`ConnectionConfig` includes a `type: DatabaseType` field. The CLI prompts for this value before collecting host/port/credentials.

### DatabaseAdapterRegistry

Defined in `infrastructure/database/registry.ts`:

```ts
interface DatabaseAdapterSet {
  createConnection(config: ConnectionConfig): IDatabaseConnection;
  createSchemaInspector(): ISchemaInspector;
  createSchemaSynchronizer(): ISchemaSynchronizer;
  createDataMigrator(): IDataMigrator;
  createSchemaTranslator?(): ISchemaTranslator;  // optional; defaults to PassthroughSchemaTranslator
}

class DatabaseAdapterRegistry {
  register(type: DatabaseType, adapters: DatabaseAdapterSet): void;
  get(type: DatabaseType): DatabaseAdapterSet;       // throws UnsupportedDatabaseError if unregistered
  getTranslator(source: DatabaseType, dest: DatabaseType): ISchemaTranslator;
  has(type: DatabaseType): boolean;
}
```

- `get()` throws `UnsupportedDatabaseError` with a message like `"MySQL adapters are not yet implemented. Planned for v2."` when the type is registered in the enum but has no adapter set.
- `getTranslator()` returns a `PassthroughSchemaTranslator` when source and destination types match, or the appropriate cross-database translator when they differ.
- The orchestrator calls `registry.get(sourceConfig.type)` and `registry.get(destConfig.type)` to resolve all adapters. It never imports PG classes directly.

### ISchemaTranslator

Defined in `domain/ports/schema-translator.port.ts`:

```ts
interface ISchemaTranslator {
  translateColumnType(sourceType: string, sourceDbType: DatabaseType, destDbType: DatabaseType): string;
  translateDefaultValue(defaultExpr: string, sourceDbType: DatabaseType, destDbType: DatabaseType): string;
  translateConstraint(constraint: ConstraintSchema, sourceDbType: DatabaseType, destDbType: DatabaseType): ConstraintSchema;
}
```

- For v1 (postgres-to-postgres), `PassthroughSchemaTranslator` returns all inputs unchanged.
- Cross-database translators (e.g., `MysqlToPostgresTranslator`) will implement the mappings: `TINYINT(1)` to `BOOLEAN`, `DATETIME` to `TIMESTAMP`, `AUTO_INCREMENT` to `SERIAL`, etc.
- The translator is invoked by `ISchemaSynchronizer.apply()` when generating DDL for the destination.

### Adapter Resolution Flow

```
CLI prompt → ConnectionConfig (with DatabaseType)
  → MigrationOrchestrator
    → registry.get(source.type) → source adapters
    → registry.get(dest.type)   → dest adapters
    → registry.getTranslator(source.type, dest.type) → translator
    → use-cases receive adapters via constructor injection
```

---

## Dependencies

### Pre-existing (already in `package.json`)

- `pg` - PostgreSQL client
- `ts-node` - TypeScript execution for development
- `ts-node-dev` - ts-node with auto-restart

### To Add

```bash
npm install pg-copy-streams
npm install -D @types/node @types/pg @types/pg-copy-streams vitest
```

- `pg-copy-streams` - COPY TO/FROM streaming
- `@types/node` (dev) - Type definitions for Node.js built-ins (`worker_threads`, `readline`, `stream`)
- `@types/pg` (dev) - Type definitions for pg
- `@types/pg-copy-streams` (dev) - Type definitions for pg-copy-streams
- `vitest` (dev) - Test runner

### Future Dependencies (not added in v1)

| Database | Driver Package | Version Notes |
|----------|---------------|---------------|
| MySQL | `mysql2` | Preferred over `mysql` for prepared statements and Promise API |
| MSSQL | `mssql` (wraps `tedious`) | Microsoft-maintained, supports Windows auth and Azure AD |
| Snowflake | `snowflake-sdk` | Official Snowflake Node.js driver |

---

## Project Structure

```
src/
├── index.ts                                    # Entry point
├── domain/
│   ├── types/
│   │   ├── connection.types.ts                 # DatabaseType enum, ConnectionConfig
│   │   ├── schema.types.ts                     # TableSchema, ColumnSchema, IndexSchema, etc.
│   │   ├── migration.types.ts                  # SchemaDiff, MigrationResult, TableMigrationResult
│   │   └── worker.types.ts                     # WorkerPayload, WorkerMessage
│   ├── errors/
│   │   └── migration.errors.ts                 # Custom error classes (incl. UnsupportedDatabaseError)
│   └── ports/
│       ├── database.port.ts                    # IDatabaseConnection
│       ├── schema-inspector.port.ts            # ISchemaInspector
│       ├── schema-synchronizer.port.ts         # ISchemaSynchronizer
│       ├── schema-translator.port.ts           # ISchemaTranslator
│       ├── data-migrator.port.ts               # IDataMigrator
│       └── logger.port.ts                      # ILogger
├── application/
│   ├── use-cases/
│   │   ├── create-database.use-case.ts         # Create dest DB if not exists
│   │   ├── compare-schemas.use-case.ts         # Inspect + diff schemas
│   │   ├── sync-schema.use-case.ts             # Apply DDL to target (uses ISchemaTranslator)
│   │   └── migrate-data.use-case.ts            # Disable triggers, run workers, reset sequences
│   └── services/
│       └── migration-orchestrator.service.ts   # Coordinates the full flow via DatabaseAdapterRegistry
├── infrastructure/
│   ├── database/
│   │   ├── registry.ts                         # DatabaseAdapterRegistry
│   │   ├── pg/
│   │   │   ├── pg-connection.adapter.ts        # pg.Pool wrapper implementing IDatabaseConnection
│   │   │   ├── pg-schema-inspector.adapter.ts  # SQL queries for schema introspection
│   │   │   ├── pg-schema-synchronizer.adapter.ts # Schema diff (pure) + DDL generation/execution
│   │   │   ├── pg-schema-translator.adapter.ts # PassthroughSchemaTranslator (returns types unchanged)
│   │   │   └── pg-adapter-set.ts               # Registers all PG adapters as a DatabaseAdapterSet
│   │   ├── mysql/                              # Future: MySQL adapters (v2)
│   │   │   └── README.md                       # Documents required interfaces and MySQL-specific notes
│   │   ├── mssql/                              # Future: MSSQL adapters (v3)
│   │   │   └── README.md
│   │   └── snowflake/                          # Future: Snowflake adapters (v3)
│   │       └── README.md
│   ├── migration/
│   │   ├── pg-data-migrator.adapter.ts         # Implements IDataMigrator, owns WorkerPool
│   │   ├── worker-pool.ts                      # Spawns/manages worker threads
│   │   └── table-copy.worker.ts                # Worker entry: COPY stream per table
│   └── logging/
│       └── console-logger.adapter.ts           # Timestamped console output
├── presentation/
│   └── cli/
│       ├── prompt.ts                           # readline-based interactive prompts (incl. database type)
│       └── cli.ts                              # CLI flow: prompt -> validate -> orchestrate
└── shared/
    └── utils.ts                                # escapeIdentifier, formatDuration, chunkArray, resolveWorkerPath

tests/
├── unit/
│   ├── domain/
│   │   └── errors.test.ts
│   ├── application/
│   │   ├── create-database.use-case.test.ts
│   │   ├── compare-schemas.use-case.test.ts
│   │   ├── sync-schema.use-case.test.ts
│   │   ├── migrate-data.use-case.test.ts
│   │   └── migration-orchestrator.service.test.ts
│   └── infrastructure/
│       ├── pg-schema-inspector.test.ts
│       ├── pg-schema-synchronizer.test.ts
│       ├── pg-schema-translator.test.ts
│       ├── pg-data-migrator.test.ts
│       ├── worker-pool.test.ts
│       └── database-adapter-registry.test.ts
├── integration/
│   └── README.md                               # Documents Docker-based integration test setup
└── helpers/
    └── mock-database.ts                        # Shared mock for IDatabaseConnection
```

---

## Key Interfaces

### `IDatabaseConnection`
```ts
connect(): Promise<void>
query<T>(sql: string, params?: any[]): Promise<T[]>
getClient(): Promise<PoolClient>  // for COPY streams
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
```

### `IDataMigrator`
```ts
migrate(sourceConfig: ConnectionConfig, destConfig: ConnectionConfig, tables: string[], workerCount: number): Promise<MigrationResult>
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
get(type: DatabaseType): DatabaseAdapterSet       // throws UnsupportedDatabaseError if unregistered
getTranslator(source: DatabaseType, dest: DatabaseType): ISchemaTranslator
has(type: DatabaseType): boolean
```

### `DatabaseAdapterSet`
```ts
createConnection(config: ConnectionConfig): IDatabaseConnection
createSchemaInspector(): ISchemaInspector
createSchemaSynchronizer(): ISchemaSynchronizer
createDataMigrator(): IDataMigrator
createSchemaTranslator?(): ISchemaTranslator  // optional; defaults to PassthroughSchemaTranslator
```

---

## Migration Flow

1. **Prompt** - Collect source and destination database type and connection details (host, port, user, password, database). Passwords are input with echo suppressed via raw mode on stdin. In v1, non-postgres types are rejected with a version-roadmap message.
2. **Resolve adapters** - Use `DatabaseAdapterRegistry` to obtain the correct adapter set for both source and destination types. Obtain the `ISchemaTranslator` for the source-destination pair.
3. **Validate connections** - Test connectivity to both servers, fail early with clear errors
4. **Create database** - Connect to dest server's `postgres` DB, check `pg_database`, `CREATE DATABASE` if missing. Runs outside a transaction (autocommit).
5. **Inspect schemas** - Query `information_schema` + `pg_catalog` on both source and destination
6. **Diff & sync schema** - Compute diff, run column types through `ISchemaTranslator`, generate DDL, apply in a single transaction (CREATE TABLE, ALTER COLUMN, add/drop constraints, CREATE SEQUENCE). **Do NOT create indexes yet** — defer until after data load for performance. Custom types (enums, composites, domains) are **out of scope for v1** — migration will fail with a clear error if source uses them.
7. **Disable triggers** - `ALTER TABLE ... DISABLE TRIGGER ALL` on all destination tables (implemented in `pg-schema-synchronizer.adapter.ts`)
8. **Migrate data** - Spawn worker threads, each streams tables via `COPY TO/FROM`. Each worker truncates target table before streaming (`TRUNCATE ... RESTRICT` — CASCADE not used; FK triggers are already disabled so dependent rows are safe). Workers report progress via `parentPort.postMessage`.
9. **Re-enable triggers** - `ALTER TABLE ... ENABLE TRIGGER ALL` (implemented in `pg-schema-synchronizer.adapter.ts`)
10. **Create indexes** - Apply deferred index DDL on destination (implemented in `pg-schema-synchronizer.adapter.ts`)
11. **Reset sequences** - Query `last_value` from source, `setval()` on destination (implemented in `pg-schema-synchronizer.adapter.ts`)
12. **Report** - Print summary table with per-table row counts, durations, and success/failure

### Error / Partial Failure Strategy

- **Step 6 (schema sync) failure**: The DDL runs in a single transaction; any failure rolls back all schema changes. Migration aborts with a clear error.
- **Step 8 (data migration) partial failure**: If one or more tables fail to copy, the migration continues for remaining tables. At the end, failed tables are reported. The destination DB is left in partial state — the CLI reports which tables succeeded and which failed, allowing the user to investigate and re-run.
- **Step 10 (index creation) failure**: Individual index creation failures are caught and reported per-index. Migration is not aborted; a warning is emitted.
- **No automatic rollback**: This is a one-shot migration tool. Resume and rollback are out of scope for v1. Partial state is explicitly reported.

---

## Implementation Order

| Step | What | Files | Testable After |
|------|------|-------|----------------|
| 1 | Project scaffold | Create `tsconfig.json`, `.gitignore` (add `dist/`, `node_modules/`), update `package.json` scripts, create `vitest.config.ts` | `npm test` runs (0 tests pass) |
| 2 | Domain types | `domain/types/*.ts` (incl. `DatabaseSchema`, `DatabaseType` enum, `ConnectionConfig` with `type` field) | Types compile cleanly |
| 3 | Domain errors + ports | `domain/errors/*.ts` (incl. `UnsupportedDatabaseError`), `domain/ports/*.ts` (incl. `schema-translator.port.ts`) | — |
| 3a | Domain errors unit tests | `tests/unit/domain/errors.test.ts` | `npm test` — error tests pass |
| 4 | Shared utilities | `shared/utils.ts` | — |
| 5 | Console logger | `infrastructure/logging/console-logger.adapter.ts` | — |
| 5a | Database adapter registry | `infrastructure/database/registry.ts` | — |
| 5b | Registry unit tests | `tests/unit/infrastructure/database-adapter-registry.test.ts` | Registry tests pass |
| 6 | PG connection adapter | `infrastructure/database/pg/pg-connection.adapter.ts` | — |
| 6a | PG schema translator (passthrough) | `infrastructure/database/pg/pg-schema-translator.adapter.ts` | — |
| 6b | PG adapter set (registers all PG adapters) | `infrastructure/database/pg/pg-adapter-set.ts` | — |
| 6c | PG translator tests | `tests/unit/infrastructure/pg-schema-translator.test.ts` | Translator tests pass |
| 6d | Test mock helper | `tests/helpers/mock-database.ts` | Imported by subsequent tests |
| 7 | Schema inspector | `infrastructure/database/pg/pg-schema-inspector.adapter.ts` | — |
| 7a | Schema inspector tests | `tests/unit/infrastructure/pg-schema-inspector.test.ts` | Inspector tests pass |
| 8 | Schema synchronizer (diff + DDL + trigger/index/sequence ops) | `infrastructure/database/pg/pg-schema-synchronizer.adapter.ts` | — |
| 8a | Schema synchronizer tests | `tests/unit/infrastructure/pg-schema-synchronizer.test.ts` | Synchronizer tests pass |
| 9 | Create database use case | `application/use-cases/create-database.use-case.ts` | — |
| 9a | Create database use case tests | `tests/unit/application/create-database.use-case.test.ts` | Create-database tests pass |
| 10 | Compare schemas use case | `application/use-cases/compare-schemas.use-case.ts` | — |
| 10a | Compare schemas tests | `tests/unit/application/compare-schemas.use-case.test.ts` | Compare tests pass |
| 11 | Sync schema use case (wired to ISchemaTranslator) | `application/use-cases/sync-schema.use-case.ts` | — |
| 11a | Sync schema tests | `tests/unit/application/sync-schema.use-case.test.ts` | Sync tests pass |
| 12 | Table copy worker | `infrastructure/migration/table-copy.worker.ts` | — |
| 13 | Worker pool | `infrastructure/migration/worker-pool.ts` | — |
| 13a | Worker pool tests | `tests/unit/infrastructure/worker-pool.test.ts` | Worker pool tests pass |
| 14 | Data migrator adapter | `infrastructure/migration/pg-data-migrator.adapter.ts` | — |
| 14a | Data migrator adapter tests | `tests/unit/infrastructure/pg-data-migrator.test.ts` | Data migrator tests pass |
| 15 | Migrate data use case | `application/use-cases/migrate-data.use-case.ts` | — |
| 15a | Migrate data use case tests | `tests/unit/application/migrate-data.use-case.test.ts` | All unit tests pass |
| 16 | Migration orchestrator (uses DatabaseAdapterRegistry) | `application/services/migration-orchestrator.service.ts` | — |
| 16a | Migration orchestrator tests | `tests/unit/application/migration-orchestrator.service.test.ts` | Orchestrator tests pass |
| 17 | Integration test scaffold | `tests/integration/README.md` with Docker Compose setup instructions | Manual: two PG containers, run orchestrator, verify data |
| 18 | CLI prompt (incl. database type selection) + CLI flow | `presentation/cli/prompt.ts`, `presentation/cli/cli.ts` | `npm start` prompts user |
| 19 | Entry point | `src/index.ts` | Full manual E2E test |
| 20 | Future DB placeholder READMEs | `infrastructure/database/mysql/README.md`, `mssql/README.md`, `snowflake/README.md` | Directory structure matches plan |

---

## Step 1 Config Details

**`tsconfig.json`** (create at project root):
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*", "tests/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**`.gitignore`** (create or update at project root):
```
node_modules/
dist/
*.env
.env*
```

**`package.json` scripts to add**:
```json
"scripts": {
  "start": "ts-node src/index.ts",
  "dev": "ts-node-dev --respawn src/index.ts",
  "build": "tsc",
  "test": "vitest run",
  "test:watch": "vitest"
}
```

**`vitest.config.ts`** (create at project root):
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    pool: 'forks',  // Required for CommonJS TypeScript compatibility with Vitest
  },
});
```

---

## Domain Types Overview

`domain/types/connection.types.ts` must define `DatabaseType` and `ConnectionConfig`:
```ts
enum DatabaseType {
  POSTGRES = 'postgres',
  MYSQL = 'mysql',
  MSSQL = 'mssql',
  SNOWFLAKE = 'snowflake',
}

interface ConnectionConfig {
  type: DatabaseType;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}
```

`domain/types/schema.types.ts` must define `DatabaseSchema` as the aggregate root used throughout:
```ts
interface DatabaseSchema {
  tables: TableSchema[];
  sequences: SequenceSchema[];
}
```
`TableSchema` holds columns, constraints, and indexes. `DatabaseSchema` is what `ISchemaInspector.inspect()` returns and what `ISchemaSynchronizer.diff()` compares.

---

## Shared Utilities (`shared/utils.ts`)

This file must export:

- `escapeIdentifier(name: string): string` — wraps a table/column name in double quotes, escaping internal double quotes. Used in all DDL generation.
- `formatDuration(ms: number): string` — human-readable duration (e.g., `"1m 23s"`). Used in the final report.
- `chunkArray<T>(arr: T[], size: number): T[][]` — splits an array into chunks of `size`. Used by the worker pool for table distribution.
- `resolveWorkerPath(filename: string): string` — returns the correct absolute path to a worker file for both development (`.ts` via ts-node) and production (`.js` from `dist/`). Checks `process.env.NODE_ENV` or whether `dist/` exists.

---

## Worker Thread Execution Strategy

Workers don't inherit the ts-node loader from the parent process.

**Development** (ts-node):
```ts
new Worker(path.resolve(__dirname, '../migration/table-copy.worker.ts'), {
  execArgv: ['-r', 'ts-node/register'],
  workerData: payload,
});
```

**Production** (compiled JS):
```ts
new Worker(path.resolve(__dirname, '../migration/table-copy.worker.js'), {
  workerData: payload,
});
```

Use `resolveWorkerPath()` from `shared/utils.ts` to select the correct path at runtime.

---

## CLI Password Input

`readline/promises` does not natively suppress terminal echo for password fields. Use raw mode on stdin to hide password characters:

```ts
async function promptPassword(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    let password = '';
    process.stdin.on('data', (char) => {
      if (char === '\r' || char === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write('\n');
        resolve(password);
      } else if (char === '\u0003') {
        process.exit();
      } else {
        password += char;
      }
    });
  });
}
```

Alternatively, passwords may be provided via environment variables (`PGPASSWORD`, `DEST_PGPASSWORD`) and the prompt skips to the next field if these are set.

---

## Future Database Support Roadmap

### v2: MySQL

**Driver**: `mysql2` (Promise API, prepared statements, connection pooling)

**Schema introspection**: `information_schema.TABLES`, `information_schema.COLUMNS`, `information_schema.KEY_COLUMN_USAGE`, `information_schema.TABLE_CONSTRAINTS`. MySQL's `information_schema` is SQL-standard, so the inspector structure mirrors the PG inspector closely.

**Data transfer**: MySQL has no `COPY` protocol equivalent. Use batched `INSERT ... VALUES` with configurable batch size (default 1000 rows). For large tables, `LOAD DATA LOCAL INFILE` is faster but requires `local_infile` enabled on both client and server, so it is offered as an opt-in mode.

**Schema translator** (MySQL to Postgres):
| MySQL Type | PostgreSQL Type |
|------------|----------------|
| `TINYINT(1)` | `BOOLEAN` |
| `DATETIME` | `TIMESTAMP WITHOUT TIME ZONE` |
| `DOUBLE` | `DOUBLE PRECISION` |
| `TEXT` / `MEDIUMTEXT` / `LONGTEXT` | `TEXT` |
| `BLOB` / `MEDIUMBLOB` / `LONGBLOB` | `BYTEA` |
| `AUTO_INCREMENT` | `SERIAL` / `GENERATED ALWAYS AS IDENTITY` |
| `ENUM('a','b')` | `VARCHAR` with `CHECK` constraint |
| `SET('a','b')` | `VARCHAR[]` or `TEXT` with `CHECK` |
| `JSON` | `JSONB` |

**Adapters to implement**:
- `infrastructure/database/mysql/mysql-connection.adapter.ts` — `IDatabaseConnection`
- `infrastructure/database/mysql/mysql-schema-inspector.adapter.ts` — `ISchemaInspector`
- `infrastructure/database/mysql/mysql-schema-synchronizer.adapter.ts` — `ISchemaSynchronizer`
- `infrastructure/database/mysql/mysql-schema-translator.adapter.ts` — `ISchemaTranslator` (MySQL-to-Postgres and Postgres-to-MySQL mappings)
- `infrastructure/database/mysql/mysql-adapter-set.ts` — `DatabaseAdapterSet` registration
- `infrastructure/migration/mysql-data-migrator.adapter.ts` — `IDataMigrator` (batch INSERT strategy)

**FK handling**: `SET FOREIGN_KEY_CHECKS = 0` / `SET FOREIGN_KEY_CHECKS = 1` (MySQL equivalent of disabling triggers).

**Worker strategy**: Same `worker_threads` pool; workers use `mysql2` connections instead of `pg` connections.

### v2: Cross-Migration (MySQL to Postgres, Postgres to MySQL)

Once both MySQL and Postgres adapters exist, cross-migration becomes possible with no orchestrator changes:
1. CLI accepts `--source-type mysql --dest-type postgres`
2. Registry resolves MySQL adapters for source, Postgres adapters for destination
3. `registry.getTranslator('mysql', 'postgres')` returns `MysqlToPostgresTranslator`
4. Schema diff runs source inspector, translates types, generates destination DDL
5. Data migration reads from MySQL (SELECT-based streaming), writes to Postgres (COPY FROM)

### v3: MSSQL

**Driver**: `mssql` (wraps `tedious`; supports Windows auth, Azure AD, encrypted connections)

**Schema introspection**: `sys.tables`, `sys.columns`, `sys.indexes`, `sys.foreign_keys`, `INFORMATION_SCHEMA` views. MSSQL's system catalog is richer than `information_schema` alone; use `sys.*` views for completeness.

**Data transfer**: BCP (Bulk Copy Program) via `mssql`'s `Table` bulk insert API. Alternatively, batched `INSERT` with `IDENTITY_INSERT ON` for identity columns.

**Schema translator** (MSSQL to Postgres):
| MSSQL Type | PostgreSQL Type |
|------------|----------------|
| `NVARCHAR(n)` | `VARCHAR(n)` |
| `NTEXT` | `TEXT` |
| `BIT` | `BOOLEAN` |
| `DATETIME2` | `TIMESTAMP WITHOUT TIME ZONE` |
| `DATETIMEOFFSET` | `TIMESTAMP WITH TIME ZONE` |
| `MONEY` | `NUMERIC(19,4)` |
| `UNIQUEIDENTIFIER` | `UUID` |
| `IMAGE` | `BYTEA` |
| `IDENTITY(1,1)` | `GENERATED ALWAYS AS IDENTITY` |

**Adapters to implement**:
- `infrastructure/database/mssql/mssql-connection.adapter.ts`
- `infrastructure/database/mssql/mssql-schema-inspector.adapter.ts`
- `infrastructure/database/mssql/mssql-schema-synchronizer.adapter.ts`
- `infrastructure/database/mssql/mssql-schema-translator.adapter.ts`
- `infrastructure/database/mssql/mssql-adapter-set.ts`
- `infrastructure/migration/mssql-data-migrator.adapter.ts`

**Special considerations**: MSSQL schemas are not limited to `public`/`dbo` — the `dbo` schema is the default, but multi-schema support may be needed. MSSQL uses `[bracketed]` identifiers instead of `"double-quoted"`.

### v3: Snowflake

**Driver**: `snowflake-sdk` (official Snowflake Node.js driver)

**Schema introspection**: `INFORMATION_SCHEMA.TABLES`, `INFORMATION_SCHEMA.COLUMNS`, `SHOW PRIMARY KEYS`, `SHOW IMPORTED KEYS`. Snowflake's `information_schema` is SQL-standard but some metadata requires `SHOW` commands.

**Data transfer**: `COPY INTO` from staged files. The migrator exports source data to local CSV/Parquet files (or internal stage), then uses `PUT` + `COPY INTO` on the Snowflake side. This is the only performant bulk-load path for Snowflake.

**Schema translator** (Snowflake to Postgres):
| Snowflake Type | PostgreSQL Type |
|----------------|----------------|
| `NUMBER(38,0)` | `BIGINT` |
| `NUMBER(p,s)` | `NUMERIC(p,s)` |
| `FLOAT` | `DOUBLE PRECISION` |
| `VARIANT` | `JSONB` |
| `ARRAY` | `JSONB` |
| `OBJECT` | `JSONB` |
| `TIMESTAMP_NTZ` | `TIMESTAMP WITHOUT TIME ZONE` |
| `TIMESTAMP_TZ` | `TIMESTAMP WITH TIME ZONE` |
| `TIMESTAMP_LTZ` | `TIMESTAMP WITH TIME ZONE` |
| `BINARY` | `BYTEA` |

**Adapters to implement**:
- `infrastructure/database/snowflake/snowflake-connection.adapter.ts`
- `infrastructure/database/snowflake/snowflake-schema-inspector.adapter.ts`
- `infrastructure/database/snowflake/snowflake-schema-synchronizer.adapter.ts`
- `infrastructure/database/snowflake/snowflake-schema-translator.adapter.ts`
- `infrastructure/database/snowflake/snowflake-adapter-set.ts`
- `infrastructure/migration/snowflake-data-migrator.adapter.ts`

**Special considerations**: Snowflake does not support traditional indexes (it uses micro-partitions). The `ISchemaSynchronizer.createIndexes()` method should be a no-op for Snowflake. Snowflake warehouse size affects concurrency — worker count should map to warehouse size, not a fixed cap. Snowflake has no sequences in the traditional sense; `AUTOINCREMENT` columns are handled differently.

### Adding a New Database: Checklist

To add support for a new database type `X`:

1. Add `X` to `DatabaseType` enum in `domain/types/connection.types.ts`
2. Create `infrastructure/database/x/` directory
3. Implement `IDatabaseConnection` — connection pooling, query execution, client acquisition
4. Implement `ISchemaInspector` — table/column/constraint/index/sequence introspection
5. Implement `ISchemaSynchronizer` — DDL generation for the target dialect, trigger disable/enable, index creation, sequence reset
6. Implement `IDataMigrator` — bulk data transfer using the database's most efficient mechanism
7. Implement `ISchemaTranslator` — type mappings from `X` to all supported destination types (and from all sources to `X`)
8. Create `x-adapter-set.ts` — wire all implementations into a `DatabaseAdapterSet`
9. Register in the application bootstrap: `registry.register(DatabaseType.X, createXAdapterSet())`
10. Add driver package to `dependencies` in `package.json`
11. Update CLI prompt to accept the new type
12. Add unit tests for all new adapters
13. Add integration test with Docker container for database `X`

---

## Known Limitations (v1)

- **Public schema only**: Targets `public` schema. Other schemas are ignored.
- **Custom types out of scope**: If source tables use custom enums, composite types, or domain types, migration will fail with a clear error message: `"Custom type '<name>' is not supported in v1. Create it manually on the destination first."`. Tables using custom types are skipped, and the rest proceed.
- **No resume/retry**: Partial migration state is reported but not automatically recovered.
- **No dry-run mode**: All changes are applied directly. Use a staging destination to preview.
- **PostgreSQL only in v1**: Only `postgres` is implemented as source and destination. Selecting `mysql`, `mssql`, or `snowflake` in the CLI produces a clear error with the planned version for that database.

---

## Key Gotchas

- **Worker ts-node**: Workers don't inherit ts-node loader. See "Worker Thread Execution Strategy" above.
- **CREATE DATABASE**: Cannot run inside a transaction — use autocommit (do not call `BEGIN` before it).
- **Sequence reset**: COPY doesn't advance sequences. Must query `last_value` from source and `setval()` on destination after data migration. Implemented in `pg-schema-synchronizer.adapter.ts`.
- **COPY backpressure**: Use `stream.pipeline()` from `stream/promises` for proper backpressure handling.
- **Schema scope**: Initial version targets `public` schema only.
- **TRUNCATE before COPY**: Each worker truncates target table before streaming (`TRUNCATE tablename RESTRICT`). `RESTRICT` (not `CASCADE`) is safe here because FK triggers are already disabled on all tables before workers start.
- **Index creation order**: Create indexes AFTER data is loaded (not as part of initial DDL sync), otherwise each row insert pays the index cost. In Step 6 of Migration Flow, apply only table/column/constraint DDL; defer index creation to Step 10.
- **Trigger disable/enable ownership**: `disableTriggers()`, `enableTriggers()`, `createIndexes()`, and `resetSequences()` all live in `pg-schema-synchronizer.adapter.ts` and are called by the orchestrator directly.
- **Vitest + CommonJS**: Set `pool: 'forks'` in `vitest.config.ts` to avoid ESM/CJS conflicts when running Vitest against CommonJS TypeScript modules.
- **Registry must be initialized before orchestrator**: The application bootstrap (in `index.ts`) must register all adapter sets before constructing the orchestrator. Missing registration causes a runtime error, not a compile-time error — the `UnsupportedDatabaseError` message should clearly state which type was requested and which types are available.

---

## Verification

1. **Unit tests**: `npm test` — all schema diffing, DDL generation, worker distribution, trigger handling, use case logic, registry resolution, and translator pass-through
2. **Integration test** (manual, Docker):
   - `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=pass postgres`
   - `docker run -d -p 5433:5433 -e POSTGRES_PASSWORD=pass postgres`
   - Create test tables with various types, constraints, indexes, and sample data on source
   - Run `npx ts-node src/index.ts`, select `postgres` as database type, enter connection details
   - Verify: destination DB created, schema matches, all data present, sequences correct
   - Test partial failure: create a table with a data conflict and verify that other tables still migrate and the failure is reported correctly
   - Test unsupported type: select `mysql` and verify the CLI rejects with a clear version-roadmap message
