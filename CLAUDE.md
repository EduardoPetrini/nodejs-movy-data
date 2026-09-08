# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Web UI work in progress.** See `docs/web-ui-progress.md` for the current
> state of the Nuxt app, the org/RBAC model, and what Phase 3 needs next.

## Commands

```bash
# Run the CLI
pnpm start                   # runs @movy/cli (tsx, no build step)
pnpm dev                     # CLI with hot reload
pnpm dev:web                 # Nuxt app on :3000

# Replay a recorded run through the runner — no database needed
pnpm simulate --journal /tmp/run.ndjson \
  --simulate apps/runner/fixtures/pg-to-pg-315k.ndjson \
  --run-id demo --speed 0.05

# Build
pnpm build                   # tsc -b across workspaces + Nuxt build

# Type check (no emit)
pnpm typecheck               # per-workspace, includes tests

# Tests
pnpm test                    # vitest run (all tests, single pass)
pnpm test:watch              # vitest watch mode
pnpm seed:dev                # dev users: admin@/editor@/viewer@movy.local

# Run a single test file
pnpm exec vitest run packages/core/tests/unit/application/migration-orchestrator.service.test.ts
```

## Architecture

This is a database-agnostic CLI migration tool ("Movy") built with **hexagonal architecture**. It migrates schema and data from one database to another.

### Layer overview

```
packages/core/          # @movy/core — the hexagon. No I/O entry points.
├── src/domain/         # Pure types, ports (interfaces), and errors — no I/O
├── src/application/    # Use cases and orchestration service
├── src/infrastructure/ # Concrete adapter implementations (pg, mysql, mssql, translators, migrators)
├── src/composition/    # buildRegistry() + Pair descriptors — the composition root
├── src/index.ts        # Public barrel — apps import ONLY from '@movy/core'
└── tests/              # Mock-driven unit tests

apps/cli/               # @movy/cli — interactive command-line surface
apps/runner/            # @movy/runner — forked per run (scaffolded; Phase 3)
apps/web/               # @movy/web — Nuxt 4 console (orgs, RBAC, connections)
```

### Domain ports (interfaces)

All database interactions are behind interfaces in `packages/core/src/domain/ports/`:

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

`buildRegistry()` (`packages/core/src/composition/build-registry.ts`) is the composition root — the one module naming every concrete Adapter Set, translator and migrator. Every delivery surface calls it; none duplicates the wiring. `DatabaseAdapterRegistry` (`packages/core/src/infrastructure/database/registry.ts`) maps a `DatabaseType` to a `DatabaseAdapterSet`. **PostgreSQL**, **MySQL** and **MSSQL** are fully registered. Cross-DB translator and migrator pairs are registered separately via `registerTranslator()` and `registerDataMigrator()`.

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

### Run events (the observable contract)

`MigrationOrchestrator.run()` and `MigrateDataUseCase.execute()` take an **optional
trailing** `ctx?: MigrationRunContext` (`{ runId, emit, signal }`). Optional is deliberate:
adding it broke no call site and no test mock. With a context supplied, the nine steps in
`MIGRATION_STEP_ORDER` are reported as typed `MigrationEvent`s
(`packages/core/src/domain/types/events.types.ts`) alongside per-table and overall progress.

Pipe events through `composeSink(runId, target)`, which is
`safe(seq(throttled(target)))`:

- `ThrottledSink` coalesces `table_progress`/`overall_progress` to one per key per 250ms.
  Necessary because `CrossDbDataMigrator` fires per 500-row batch.
- `SeqSink` sits **outside** the throttle so coalesced events never consume a `seq`,
  keeping the replay cursor gapless. It also runs in the producing process, never the
  consumer, so a consumer restart cannot reset the counter.
- `SafeSink` swallows consumer exceptions: telemetry must not abort a migration.

`SinkLogger` composed into `TeeLogger` puts every existing `logger.*` call onto the same
stream without touching those call sites.

**Events describe progress, never configuration.** `SafeEndpoint` carries engine and
database only — no host, port or credentials — because events are broadcast to read-only
viewers.

`--json-events[=<path>]` on the CLI records the stream as NDJSON beside the log file.

### Runs in the web app (@movy/web)

The web app forks the runner once per run and rebuilds run state from its
events. Four tables: `runs` plus `run_events` and the two projections
`run_steps` / `run_table_progress`.

| Module | Purpose |
|--------|---------|
| `server/runs/run-projection.ts` | **Pure.** Folds a batch of events into row patches. No I/O, so every ordering rule is testable against the recorded fixture. |
| `server/runs/event-writer.ts` | Batches events (200 / 250ms) into one transaction per run. Never rethrows: a failed metadata write must not kill a live migration. |
| `server/runs/journal-tailer.ts` | Reads a journal forward from a `seq` cursor; tolerates a half-written trailing line. |
| `server/runs/run-manager.ts` | Forks the runner `detached`, feeds IPC to the writer, cancels, and re-attaches on boot. |
| `server/repositories/runs.repo.ts` | Org-scoped reads; plus the unscoped ingestion helpers the manager uses. |

**`run_events` is keyed on `(run_id, seq)`.** Events arrive from IPC *and* from
the journal tailer, so delivery is at-least-once from two sources. That key is
what makes the second delivery an `ON CONFLICT DO NOTHING` no-op instead of a
duplicate. Do not add a surrogate id.

**`reattach()` is not a one-shot read.** IPC dies with the old host and cannot be
re-established, so a run still in flight after a restart is *followed* — its
journal re-read each second until a terminal event or the owning process is
gone. A run whose process vanished with no outcome is settled `failed` /
`RunnerVanished`, and the message says the migration may be partially applied,
because Movy has no resume.

**The two log cohorts live in one predicate**: `mayReadLogs(role)` in
`run.serializer.ts`. A viewer has `run:read` but not `run:log:read`, so the
events route asks only for the non-`log` types — there is no filtered-out row to
leak. The socket rooms must reuse this, not re-decide it.

Journals go to `apps/web/.movy/runs/` (`MOVY_JOURNAL_DIR` overrides), each with a
`.stderr.log` beside it. The runner entry resolves to `@movy/runner`'s built
`dist/main.js` first, so **`pnpm build` after editing the runner** or the stale
build is what actually runs.

### The runner (@movy/runner)

`apps/runner` is forked once per run by the web app. It owns what the core
refuses to: argv, stdin, signals, IPC framing, the NDJSON journal and exit codes.
See `apps/runner/README.md` for the full contract.

```bash
movy-runner --journal <path> [--run-id <id>] < spec.json          # real run
movy-runner --journal <path> --simulate <fixture> --run-id <id>   # replay
```

**The run spec arrives on stdin, never in argv.** `ps` is world-readable and the
spec carries two database passwords. `RunSpecError` names the offending field
and never its value, because that message is sent to the host as a `fatal`.

**The journal is the system of record; IPC is a copy.** The runner is forked
`detached`, so it outlives a host restart. Every event is written to the file
*before* `process.send()`, and the host re-attaches by reading forward from the
last `seq` it stored — a missing IPC message is never a missing event.

**Exit codes**: 0/1/2 are succeeded/failed/cancelled, so a host that lost its
channel can still classify the run; 64 (bad argv or spec) and 70 (the runner
itself broke) mean the run never started.

`--simulate` replays a recorded journal — `runId` and `at` rewritten, `seq`
preserved — through the identical `publish()` path a real run uses. That is how
the web timeline is built and tested before a database is involved. Recorded
events bypass `composeSink`, since a second `SeqSink` would renumber them.

### Data migration — migrator selection

`registry.getDataMigrator(source, dest)` selects:
- **PG→PG**: `PgDataMigrator` — `WorkerPool` + `pg-copy-streams`, parallel worker threads (up to 4), largest tables first
- **MySQL→MySQL**: `MysqlDataMigrator` — batched SELECT + INSERT (`BATCH_SIZE=500`), sequential
- **MSSQL→MSSQL**: `MssqlDataMigrator` — batched SELECT + INSERT (`BATCH_SIZE=500`), sequential, `IDENTITY_INSERT` toggled per table
- **MySQL↔PG**: `CrossDbDataMigrator` — batched SELECT + INSERT, sequential, handles both directions
- **MSSQL↔PG / MSSQL↔MySQL**: `MssqlCrossDbDataMigrator` — batched SELECT + INSERT, sequential, IDENTITY detection for MSSQL destinations

### Clearing the destination

Every migrator empties the destination tables before loading, but PostgreSQL
needs the whole load set cleared in **one** statement: it refuses
`TRUNCATE parent` whenever another table references it, and that is a
structural check which step 4's `DISABLE TRIGGER ALL` does **not** lift.
Clearing per table meant every FK-parent failed on a re-run into a populated
destination. `truncatePgTables()`
(`packages/core/src/infrastructure/migration/pg-truncate.ts`) handles this for
both PG-destination Pairs; it is grouped rather than `CASCADE` so that a
table outside the migration set is never silently emptied.

For PG->PG this happens once in `PgDataMigrator` before the WorkerPool starts —
never inside a worker, where it would also race parallel copies. MySQL
destinations rely on `FOREIGN_KEY_CHECKS = 0` and MSSQL on a row-removal
fallback, both of which already worked.

### Cross-database schema translation

`CrossDbSchemaTranslator` (`packages/core/src/infrastructure/database/translation/cross-db-schema-translator.ts`) is the abstract base class. It does normalised type lookup with precision-suffix propagation. Concrete subclasses:
- `MysqlToPostgresTranslator` — uses `MYSQL_TO_POSTGRES_TYPE_MAP`
- `PostgresToMysqlTranslator` — uses `POSTGRES_TO_MYSQL_TYPE_MAP`
- `MssqlToPostgresTranslator` — uses `MSSQL_TO_POSTGRES_TYPE_MAP`
- `MssqlToMysqlTranslator` — uses `MSSQL_TO_MYSQL_TYPE_MAP`
- `PostgresToMssqlTranslator` — uses `POSTGRES_TO_MSSQL_TYPE_MAP`
- `MysqlToMssqlTranslator` — uses `MYSQL_TO_MSSQL_TYPE_MAP`

Default-value translation is delegated to `DefaultValueTranslator`, injected into each subclass.

### Schema types

`packages/core/src/domain/types/schema.types.ts` defines the canonical in-memory schema representation: `DatabaseSchema` → `TableSchema[]` + `SequenceSchema[]` + `EnumSchema[]`. Each `TableSchema` has `ColumnSchema[]`, `ConstraintSchema[]`, and `IndexSchema[]`.

### Tests

- Unit tests live in `packages/core/tests/unit/`, `apps/cli/tests/unit/`, `apps/runner/tests/unit/` and `apps/web/tests/unit/`.
- `apps/runner/tests/process/` forks the real runner binary (detached, with IPC) and asserts the contract the web app depends on. It needs no database. `host-death.test.ts` kills a real parent mid-replay: the orphan must finish its journal, which is the premise the whole re-attach design rests on.
- Integration tests directory exists (`packages/core/tests/integration/`) with a README explaining they require real DB connections and are not automated.
- `packages/core/tests/helpers/mock-database.ts` provides shared mock `IDatabaseConnection` for unit tests.
- Tests use **Vitest** with `globals: true`, `pool: 'forks'`.
- The whole suite is mock-driven and runs without any database.
- `pnpm test:coverage` produces a coverage report. Thresholds in `vitest.config.ts` are set to the current measured floor and ratchet upward; the target is 80%.

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
