# Movy

A database-agnostic CLI migration tool. Migrates schema and data between PostgreSQL and MySQL databases.

## Features

- Full schema migration (tables, columns, constraints, indexes, sequences/enums)
- Cross-database migrations: PostgreSQL ↔ MySQL
- Same-database high-throughput migrations (PostgreSQL → PostgreSQL via `pg-copy-streams` workers)
- Schema diff — only applies changes that are missing on the destination
- Custom query migration: run a SQL query on the source and land the results as a new table on the destination
- Row-count validation to verify migration completeness
- Structured logs written to console and a timestamped file under `logs/`

## Requirements

- Node.js 18+
- Access to source and destination databases

## Installation

```bash
npm install
```

## Usage

```bash
# Interactive CLI
npm start

# Hot-reload dev mode
npm run dev
```

The CLI will prompt for:

1. **App mode** — `migrate` or `validate`
2. **Source connection** — database type, host, port, credentials, database name
3. **Destination connection** — same fields (defaults to source database name)
4. **Migration mode** (migrate only) — `full` (entire database) or `query` (custom SQL → new table)
5. **Execution review** — confirm before running, optionally run row-count validation afterward

## Supported databases

| Database   | Source | Destination |
|------------|--------|-------------|
| PostgreSQL | ✅     | ✅          |
| MySQL      | ✅     | ✅          |

Cross-engine pairs supported: MySQL → PostgreSQL and PostgreSQL → MySQL.

## Commands

```bash
npm start          # run the CLI
npm run dev        # run with hot reload (ts-node-dev)
npm run build      # compile TypeScript to dist/
npm test           # run all unit tests (vitest)
npm run test:watch # vitest in watch mode
npx tsc --noEmit   # type-check without emitting
```

## Architecture

Built with **hexagonal architecture** — domain logic is pure TypeScript with no I/O; all database interactions go through ports (interfaces).

```
src/
├── domain/           # Types, ports (interfaces), errors — no I/O
├── application/      # Use cases and MigrationOrchestrator
├── infrastructure/   # Concrete adapters (pg, mysql, translators, migrators)
└── presentation/     # CLI prompts and entry point
```

### Migration flow

1. Create destination database if it doesn't exist
2. Inspect source schema; diff against destination
3. Apply schema diff (tables, columns, constraints)
4. Disable FK checks / triggers on destination
5. Migrate data (parallel workers for same-engine; batched SELECT/INSERT for cross-engine)
6. Re-enable FK checks / triggers
7. Create indexes
8. Reset sequences (PostgreSQL only)

### Adding a new database

1. Implement `DatabaseAdapterSet` in `src/infrastructure/database/<engine>/`
2. Register it in `cli.ts`:
   ```ts
   registry.register(DatabaseType.X, new XAdapterSet())
   ```
3. Register cross-DB translators and migrators for any new source↔dest pairs.

## Logs

Each run writes a log file to `logs/movy_YYYY-MM-DD_HH-MM-SS_<src>_to_<dst>.log`.

## Tests

Unit tests live in `tests/unit/`. Integration tests (`tests/integration/`) require real database connections and are not automated.

```bash
npm test
npx vitest run tests/unit/application/migration-orchestrator.service.test.ts
```
