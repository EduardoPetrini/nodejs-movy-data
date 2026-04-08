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

## Dependencies to Add

```bash
npm install pg-copy-streams
npm install -D @types/pg @types/pg-copy-streams vitest
```

- `pg-copy-streams` - COPY TO/FROM streaming
- `@types/pg` (dev) - Type definitions for pg
- `@types/pg-copy-streams` (dev) - Type definitions for pg-copy-streams
- `vitest` (dev) - Test runner

---

## Project Structure

```
src/
├── index.ts                                    # Entry point
├── domain/
│   ├── types/
│   │   ├── connection.types.ts                 # ConnectionConfig
│   │   ├── schema.types.ts                     # TableSchema, ColumnSchema, IndexSchema, etc.
│   │   ├── migration.types.ts                  # SchemaDiff, MigrationResult, TableMigrationResult
│   │   └── worker.types.ts                     # WorkerPayload, WorkerMessage
│   ├── errors/
│   │   └── migration.errors.ts                 # Custom error classes
│   └── ports/
│       ├── database.port.ts                    # IDatabaseConnection
│       ├── schema-inspector.port.ts            # ISchemaInspector
│       ├── schema-synchronizer.port.ts         # ISchemaSynchronizer
│       ├── data-migrator.port.ts               # IDataMigrator
│       └── logger.port.ts                      # ILogger
├── application/
│   ├── use-cases/
│   │   ├── create-database.use-case.ts         # Create dest DB if not exists
│   │   ├── compare-schemas.use-case.ts         # Inspect + diff schemas
│   │   ├── sync-schema.use-case.ts             # Apply DDL to target
│   │   └── migrate-data.use-case.ts            # Disable triggers, run workers, reset sequences
│   └── services/
│       └── migration-orchestrator.service.ts   # Coordinates the full flow
├── infrastructure/
│   ├── database/
│   │   ├── pg-connection.adapter.ts            # pg.Pool wrapper implementing IDatabaseConnection
│   │   ├── pg-schema-inspector.adapter.ts      # SQL queries for schema introspection
│   │   └── pg-schema-synchronizer.adapter.ts   # Schema diff (pure) + DDL generation/execution
│   ├── migration/
│   │   ├── pg-data-migrator.adapter.ts         # Implements IDataMigrator, owns WorkerPool
│   │   ├── worker-pool.ts                      # Spawns/manages worker threads
│   │   └── table-copy.worker.ts                # Worker entry: COPY stream per table
│   └── logging/
│       └── console-logger.adapter.ts           # Timestamped console output
├── presentation/
│   └── cli/
│       ├── prompt.ts                           # readline-based interactive prompts
│       └── cli.ts                              # CLI flow: prompt -> validate -> orchestrate
└── shared/
    └── utils.ts                                # escapeIdentifier, formatDuration, chunkArray

tests/
├── unit/
│   ├── domain/
│   │   └── errors.test.ts
│   ├── application/
│   │   ├── compare-schemas.use-case.test.ts
│   │   ├── sync-schema.use-case.test.ts
│   │   └── migrate-data.use-case.test.ts
│   └── infrastructure/
│       ├── pg-schema-inspector.test.ts
│       ├── pg-schema-synchronizer.test.ts
│       └── worker-pool.test.ts
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
```

### `IDataMigrator`
```ts
migrate(sourceConfig: ConnectionConfig, destConfig: ConnectionConfig, tables: string[], workerCount: number): Promise<MigrationResult>
```

---

## Migration Flow

1. **Prompt** - Collect source and destination connection details (host, port, user, password, database)
2. **Validate connections** - Test connectivity to both servers, fail early with clear errors
3. **Create database** - Connect to dest server's `postgres` DB, check `pg_database`, `CREATE DATABASE` if missing
4. **Inspect schemas** - Query `information_schema` + `pg_catalog` on both source and destination
5. **Diff & sync schema** - Compute diff, generate DDL, apply in a single transaction (CREATE TABLE, ALTER COLUMN, add/drop constraints, CREATE SEQUENCE). **Do NOT create indexes yet** — defer until after data load for performance.
6. **Disable triggers** - `ALTER TABLE ... DISABLE TRIGGER ALL` on all destination tables
7. **Migrate data** - Spawn worker threads, each streams tables via `COPY TO/FROM`. Workers report progress via `parentPort.postMessage`
8. **Re-enable triggers** - `ALTER TABLE ... ENABLE TRIGGER ALL`
9. **Create indexes** - Apply deferred index DDL on destination (after data is fully loaded)
10. **Reset sequences** - Query `last_value` from source, `setval()` on destination
11. **Report** - Print summary table with per-table row counts, durations, and success/failure

---

## Implementation Order

| Step | What | Files | Testable After |
|------|------|-------|----------------|
| 1 | Project config | `tsconfig.json`, `package.json` scripts, `vitest.config.ts` | `npm test` runs (0 tests pass) |
| 2 | Domain types | `domain/types/*.ts` (incl. `DatabaseSchema`) | Types compile cleanly |
| 3 | Domain errors + ports | `domain/errors/*.ts`, `domain/ports/*.ts` | — |
| 3a | Domain errors unit tests | `tests/unit/domain/errors.test.ts` | `npm test` — error tests pass |
| 4 | Shared utilities | `shared/utils.ts` | — |
| 5 | Console logger | `infrastructure/logging/console-logger.adapter.ts` | — |
| 6 | PG connection adapter | `infrastructure/database/pg-connection.adapter.ts` | — |
| 6a | Test mock helper | `tests/helpers/mock-database.ts` | Imported by subsequent tests |
| 7 | Schema inspector | `infrastructure/database/pg-schema-inspector.adapter.ts` | — |
| 7a | Schema inspector tests | `tests/unit/infrastructure/pg-schema-inspector.test.ts` | Inspector tests pass |
| 8 | Schema synchronizer (diff + DDL) | `infrastructure/database/pg-schema-synchronizer.adapter.ts` | — |
| 8a | Schema synchronizer tests | `tests/unit/infrastructure/pg-schema-synchronizer.test.ts` | Synchronizer tests pass |
| 9 | Create database use case | `application/use-cases/create-database.use-case.ts` | — |
| 10 | Compare schemas use case | `application/use-cases/compare-schemas.use-case.ts` | — |
| 10a | Compare schemas tests | `tests/unit/application/compare-schemas.use-case.test.ts` | Compare tests pass |
| 11 | Sync schema use case | `application/use-cases/sync-schema.use-case.ts` | — |
| 11a | Sync schema tests | `tests/unit/application/sync-schema.use-case.test.ts` | Sync tests pass |
| 12 | Table copy worker | `infrastructure/migration/table-copy.worker.ts` | — |
| 13 | Worker pool | `infrastructure/migration/worker-pool.ts` | — |
| 13a | Worker pool tests | `tests/unit/infrastructure/worker-pool.test.ts` | Worker pool tests pass |
| 14 | Data migrator adapter | `infrastructure/migration/pg-data-migrator.adapter.ts` | — |
| 15 | Migrate data use case | `application/use-cases/migrate-data.use-case.ts` | — |
| 15a | Migrate data use case tests | `tests/unit/application/migrate-data.use-case.test.ts` | All unit tests pass |
| 16 | Migration orchestrator | `application/services/migration-orchestrator.service.ts` | — |
| 17 | CLI prompt + CLI flow | `presentation/cli/prompt.ts`, `presentation/cli/cli.ts` | `npm start` prompts user |
| 18 | Entry point | `src/index.ts` | Full manual E2E test |

---

## Step 1 Config Details

**`tsconfig.json`** (minimum required):
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

**`vitest.config.ts`**:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
```

---

## Domain Types Overview

`domain/types/schema.types.ts` must define `DatabaseSchema` as the aggregate root used throughout:
```ts
interface DatabaseSchema {
  tables: TableSchema[];
  sequences: SequenceSchema[];
}
```
`TableSchema` holds columns, constraints, and indexes. `DatabaseSchema` is what `ISchemaInspector.inspect()` returns and what `ISchemaSynchronizer.diff()` compares.

---

## Key Gotchas

- **Worker ts-node**: Workers don't inherit ts-node loader. Pass `execArgv: ['-r', 'ts-node/register']` to Worker constructor.
- **CREATE DATABASE**: Cannot run inside a transaction - use autocommit.
- **Sequence reset**: COPY doesn't advance sequences. Must query `last_value` from source and `setval()` on destination after data migration.
- **COPY backpressure**: Use `stream.pipeline()` from `stream/promises` for proper backpressure handling.
- **Schema scope**: Initial version targets `public` schema only.
- **TRUNCATE before COPY**: Each worker truncates target table before streaming (clean one-shot migration).
- **Index creation order**: Create indexes AFTER data is loaded (not as part of initial DDL sync), otherwise each row insert pays the index cost. In Step 5 of Migration Flow, apply only table/column/constraint DDL; defer index creation to after Step 8 (re-enable triggers).

---

## Verification

1. **Unit tests**: `npm test` - all schema diffing, DDL generation, worker distribution, and use case logic
2. **Manual E2E test**:
   - Spin up two local PostgreSQL instances (e.g., Docker: `docker run -p 5432:5432 -e POSTGRES_PASSWORD=pass postgres` and `docker run -p 5433:5433 -e POSTGRES_PASSWORD=pass postgres`)
   - Create test tables with various types, constraints, indexes, and sample data on source
   - Run `npx ts-node src/index.ts`, enter connection details
   - Verify: destination DB created, schema matches, all data present, sequences correct
