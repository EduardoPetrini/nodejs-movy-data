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

Pipe events through `composeSink(runId, target, { secrets })`, which is
`safe(redact(throttled(seq(target))))`:

- `ThrottledSink` coalesces `table_progress`/`overall_progress` to one per key per 250ms.
  Necessary because `CrossDbDataMigrator` fires per 500-row batch.
- `SeqSink` sits **outside** the throttle so coalesced events never consume a `seq`,
  keeping the replay cursor gapless. It also runs in the producing process, never the
  consumer, so a consumer restart cannot reset the counter.
- `RedactingSink` replaces the run's passwords wherever they appear. It is the net, not
  the design — see below.
- `SafeSink` swallows consumer exceptions: telemetry must not abort a migration.

`SinkLogger` composed into `TeeLogger` puts every existing `logger.*` call onto the same
stream without touching those call sites.

**Events describe progress, never configuration.** `SafeEndpoint` carries engine and
database only — no host, port or credentials — because events are broadcast to read-only
viewers.

**Two strings on every event are written by code that has never heard of that rule**:
`log.message` and a `SerialisedError`'s `message`. A driver that quotes its DSN back on a
failed handshake lands a password on a stream viewers subscribe to. `createRedactingSink`
scrubs both — including percent-encoded forms, since a credential usually leaks inside a
URI — at the one seam that feeds the journal, IPC and the socket alike. Secrets under
four characters are skipped deliberately: redacting `"ab"` shreds every message and
advertises the password by the gaps. `credential-redaction.test.ts` drives a real
orchestrator whose driver echoes the DSN and searches every emitted byte; it fails if
someone widens `SafeEndpoint`.

The sink is not the only path. The runner's `fatal` frame bypasses it entirely and the
host persists it to `runs.error_message`, so both fatal paths in `main.ts` scrub through
`specNeedles(spec)` before touching stderr or IPC. And `redactValue` fails **closed**
past its depth cap: it replaces any string *or container* it could not walk, because
forwarding a subtree it never searched is a hole at exactly the depth someone would aim
for. Scalars pass through — a number cannot carry a password.

On the web side the same rule is `safeErrorMessage` / `describeConnectionFailure`
(`server/utils/safe-error.ts`), used by the five handlers that report a failed connection
as data — Test, list databases, list tables, preview, compare. `recordTest` **persists**
that message to `connections.last_test_error`, which `toPublicConnection` serves to
viewers, so an unscrubbed driver error there is a disclosure with a long shelf life.

**`classifyConnectionError` gives a failure a kind**: `auth`, `unreachable`,
`permission`, `missing_database`, `tls`, `timeout` or `unknown`. Matched on driver codes
first (`28P01`, `ER_ACCESS_DENIED_ERROR`, `ELOGIN`, `ECONNREFUSED`) and prose only as a
fallback, because codes are stable and localised prose is not. It answers `unknown`
rather than guessing: telling someone their password is wrong when the host is
unreachable sends them to rotate a working credential.

**Cancellation stops work, and never rolls back.** `ctx.signal` is checked before every
step (`MigrationOrchestrator.step`), before every table and inside every batch loop
(`throwIfCancelled`), and `WorkerPool.terminate()` kills the threads — an `AbortSignal`
in the parent is invisible to a worker running a blocking `COPY` in another realm. The
pool resolves rather than rejects when terminated, so `PgDataMigrator` re-checks the
signal itself; otherwise a cancelled run reads as a partial success. A cancelled run
leaves the destination partly written, and every surface reporting one must say so.

**A cancellation is not a table outcome — it ends the run.** Each sequential migrator
wraps a table's copy in a try/catch that turns a failure into a `TableMigrationResult`,
so `rethrowIfCancelled` has to head that catch: swallowed, it recorded a cancelled table
as a FAILED one, and when that table was last in `loadOrder` there was nothing left to
re-check, so `migrate()` returned `success: true` for a cancelled run. Each iteration
also ends with `throwIfCancelled`, because the copy loop breaks on a short final batch
without re-reading the signal. Do not rely on `MigrationOrchestrator` gating the steps
that follow to notice — that accident is what masked both bugs. Every migrator also
checks before clearing the destination, which is the most destructive thing a run does.

`--json-events[=<path>]` on the CLI records the stream as NDJSON beside the log file.

### Runs in the web app (@movy/web)

The web app forks the runner once per run and rebuilds run state from its
events. Five tables: `migration_definitions` (the saved, repeatable migration)
and `runs`, plus `run_events` and the two projections `run_steps` /
`run_table_progress`. Two more hold comparisons: `validation_runs` and
`validation_table_counts`.

| Module | Purpose |
|--------|---------|
| `server/runs/run-projection.ts` | **Pure.** Folds a batch of events into row patches. No I/O, so every ordering rule is testable against the recorded fixture. |
| `server/runs/event-writer.ts` | Batches events (200 / 250ms) into one transaction per run. Never rethrows: a failed metadata write must not kill a live migration. |
| `server/runs/journal-tailer.ts` | Reads a journal forward from a `seq` cursor; tolerates a half-written trailing line. |
| `server/runs/run-manager.ts` | Forks the runner `detached`, feeds IPC to the writer, cancels, and re-attaches on boot. |
| `server/repositories/runs.repo.ts` | Org-scoped reads; plus the unscoped ingestion helpers the manager uses. |
| `server/runs/resolve-target.ts` | Settles definition, connections, databases and mode for **both** preview and launch. |
| `server/definitions/build-preview.ts` | **Pure.** Two schemas + a diff + a plan → the review screen and its warnings. |

**`run_events` is bounded by two things and neither is the schema.** A per-run cap in
`EventWriter` stops storing `log` events past 20k — the one unbounded type, since
`SinkLogger` puts every `logger.*` call on the stream and `MigrateDataUseCase` logs per
500-row batch. The boundary event is REPLACED by a notice carrying the same `seq` rather
than dropped, because a log pane that simply stops reads as a hang. Structural events are
never capped: losing a `run_finished` leaves a run permanently unsettled. Separately,
`run-retention.ts` sweeps daily and honours `organizations.retention_days` — only
`run_events`, never `runs`/`run_steps`/`run_table_progress`, which are the ledger.

**A stalled run is reported, not settled.** `onStalled` fires after 30 minutes of
silence from a process that is still alive. It does not fail the run: marking a live run
failed frees its org's concurrency slot and lets a second run launch into a destination
the first is still writing to. Thirty minutes is chosen against a `CREATE INDEX` over
tens of millions of rows, which emits nothing while it runs.

**Both cohorts of run are watched, by two different mechanisms.** `follow()` covers runs
ADOPTED after a restart, checking each journal read; a shared unref'd sweep
(`stallCheckIntervalMs`, 60s) covers the ones this host FORKED, whose `Handle` carries
`lastEventAt`. For a while only the first existed, which left the ordinary case
unwatched — a runner wedged on a lock holds its IPC channel open, writes nothing and
never exits, so neither the exit handler nor the journal tailer has anything to fire on.

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
events route and the snapshot loader ask only for the non-`log` types — there is
no filtered-out row to leak. `cohortFor(role)` in `run-hub.ts` is the same
predicate for the socket rooms.

### History, comparison and drift

| Module | Purpose |
|--------|---------|
| `shared/keyset-cursor.ts` | **Pure.** The ledger's `(createdAt, id)` page cursor, encoded. Returns `undefined` for anything it did not write — never throws, never guesses. |
| `server/repositories/paging.ts` | `clampLimit` and `toPage`, shared by both ledgers so "one page" means the same thing in each. |
| `server/repositories/validations.repo.ts` | Org-scoped comparisons. Children key on the parent alone, so `requireValidation` is the only way in. |
| `server/repositories/stats.repo.ts` | The org home's counts and percentiles. Crosses tables, so it owns none of them. |
| `app/components/compare/CountComparisonTable.vue` | Two counts per table, diverging bar centred on 100 %. |
| `app/components/run/SchemaDiffView.vue` | The diff, read the same way by the run review screen and the compare page. |

**The ledger pages by keyset, never `OFFSET`.** Rows arrive at its head while it
is being read — that is what a run ledger is — and under an offset a run
launched between two pages shifts every later row down by one, so the reader
sees one twice and never sees another. The cursor carries `id` as well as
`created_at` because two runs launched a click apart share a millisecond. A
cursor that does not decode is a **400**, never a silent page one: a paging
client handed page one when it asked for page three loops forever.

**A run's `definitionName` is joined; its endpoints stay snapshotted.** Opposite
choices in one row, deliberately: definitions are archived and never deleted, so
renaming a migration renames it across all of history at once, which is what
renaming means — while a database is a fact about what ran.

**Comparisons resolve through `resolveRunTarget` with `checkMode: false`.** They
run no migration, so the launch gate does not apply; a query definition is
refused by the handler with the reason that is true of a comparison rather than
the one about a blank timeline. Both 422s exist and say different things.

**Drift is `POST …/runs/preview` read the other way round** — "what would a run
change?" is, after a migration, "what did it not apply?". One endpoint and one
`SchemaDiffView`, so the two screens cannot develop two ideas of a difference.

**`POST …/validations` counts inside the request.** Fine for the fixtures,
wrong for a database where one `COUNT(*)` takes minutes; the `running` status
is shaped for an out-of-band version that does not exist yet.

### The live stream

Nitro's own WebSocket support (`nitro.experimental.websocket`, crossws), not
Socket.IO — crossws is already a dependency and needs no access to the raw HTTP
server. Handler: `server/routes/_ws/runs.ts`.

| Module | Purpose |
|--------|---------|
| `server/runs/run-hub.ts` | Rooms, fan-out, cohort split, role revalidation. Membership is a plain data structure so isolation is unit-testable. |
| `server/runs/subscription-ticket.ts` | Single-use, 30s, CSPRNG tickets. Constant-time lookup. |
| `server/runs/snapshot.ts` | A subscriber's opening state, read with the grant's org id in the WHERE clause. |

**The socket performs no authorisation.** A client POSTs
`/api/orgs/:slug/runs/:id/ticket` — an ordinary request that has been through
auth, org resolution, a permission gate and an org-scoped lookup — and redeems
the result. `roomKey()` is therefore reachable only with a `SubscriptionGrant`,
so nothing from the wire can reach a room name. Do not add a string-keyed join;
`socket-isolation.test.ts` asserts the source shape, not only the behaviour.

**Broadcast happens after the durable write** (`EventWriter.onFlushed`). A
client reads its snapshot from the database and then goes live, so announcing an
event before it is queryable would leave a hole the client cannot detect. For
the same reason a peer joins its room *before* its snapshot is read: an overlap
is a duplicate the client drops by `seq`, which a gap is not.

**A demotion reaches a live socket** within one 5s revalidation interval — one
batched query for all subscribers, deduplicated per person. The subscriber's
cohort is on the SNAPSHOT as well as on `cohort_changed`: a viewer is never
demoted mid-session, so without it they never learn why their log pane is empty.

### The run UI

`shared/run-wire.ts` and `shared/definition-wire.ts` (Nuxt 4's `shared/`,
imported by both halves) are the one declaration of the wire contract — frames, row shapes, step ids and labels. The
serializer's return types are annotated with it, so a field the server stops
sending is a type error in the client. It restates the nine step ids rather than
importing `MIGRATION_STEP_ORDER`, because `@movy/core` is CommonJS and
externalised; `step-order.test.ts` fails if the copy drifts.

| Module | Purpose |
|--------|---------|
| `app/utils/run-reducer.ts` | **Pure.** Folds snapshot + live frames into view state. De-dupes by `seq`, takes the outcome from `run_finished`, never un-finishes a table. |
| `app/composables/useRunStream.ts` | Ticket, socket, backoff, and REST catch-up on the same `afterSeq` cursor. |
| `app/components/run/` | `RunHeader`, `RunTimeline`, `TableProgressGrid`, `LogStream`, `PairSelector`, `PreviewPanel`. |
| `app/composables/usePairs.ts` | `GET /api/pairs` once, shared; every predicate re-exported from `#shared/pair-capability`. |

**Both halves must be tested against the same shape.** The hub once published
bare `MigrationEvent`s while the snapshot sent `WireEvent` rows; every unit test
passed because each side built its own idea of the wire, and it only failed in a
browser. `socket-isolation.test.ts` now feeds the hub's real output through the
real reducer.

**Saved migrations (`migration_definitions`) make a run repeatable**, and a run
records the `definition_id` it came from. Definitions are **archived, never
deleted** — a run points at the one that produced it, and that attribution is
the only thing tying a year of history to one migration. The name's unique index
is partial on `archived_at IS NULL` so archiving frees the name; the connection
FKs are `restrict`, so deleting a connection a definition still names is a 409.

**`shared/pair-capability.ts` owns both the decision and its wording.** The form,
`prepareDefinition` and `resolveRunTarget` all import it, so a control disabled
in the UI and a 422 from the API say the same sentence. The rule is *disabled
with the reason shown, never a run that fails on its first step* — achievable
only from one module. `saveAvailability` is deliberately more permissive than
`modeAvailability`: **query mode may be saved but not launched**, because
`MigrateQueryUseCase` emits no events, so its timeline would stay blank for the
whole run. Run it from the CLI. A test asserts launching is never laxer than
saving.

**Preview and launch resolve through the same function.** `resolveRunTarget()`
is called by both, so the run that starts is the run that was reviewed. Preview
is strictly read-only and creates nothing — a missing destination database is
reported (`targetDatabaseExists: false`) and diffed against an empty schema,
which is what the run does after step 1, rather than refused.

**PostgreSQL raises `23001` for `ON DELETE RESTRICT`, not `23503`.** Both are
matched in `server/repositories/pg-errors.ts`. Matching only the latter turned a
409 into a 500 quoting the constraint name, and the unit test asserting the
assumed code passed the whole time — only a live database found it.

**A run request never names a path on the host.** `simulate: true`, and the
server resolves the fixture — an earlier version took `simulateFixture` off the
body and handed it to a child process as `--simulate <path>`.

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

### End-to-end tests

`apps/web/tests/e2e/` is Playwright and is **not** part of `pnpm test`. The rest of the
suite is mock-driven and runs with nothing installed; this needs a migrated database and
`pnpm seed:dev`, so it lives behind `pnpm test:e2e` for the same reason
`packages/core/tests/integration/` is not automated.

The run it drives is **simulated** — the bundled fixture replayed through the real
runner, socket, writer and reducer — so it exercises the whole machinery without
depending on two throwaway databases existing on whoever's machine runs it.

**The mid-run reload is the point.** Everything else is covered by unit tests against
mocks; what none of them can cover is a real browser losing its WebSocket, re-fetching a
snapshot from the database, and continuing from the same `seq` without a gap or a
duplicate.

Two traps, both cost an hour once: sign-in must wait for hydration
(`waitForLoadState('networkidle')`) or `fill` writes into inputs Vue has not bound yet
and the submit posts nothing; and authenticated API setup must use `page.request`, not
the top-level `request` fixture, which carries no session cookie and 401s in a way that
looks like a permission bug.
