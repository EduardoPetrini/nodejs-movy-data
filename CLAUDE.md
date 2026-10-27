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
pnpm seed:dev                # dev users: admin@/editor@/viewer@movy.local; ops@ is a platform operator

# Run a single test file
pnpm exec vitest run packages/core/tests/unit/application/migration-orchestrator.service.test.ts

# Docker Compose: console + meta-db + seeded PG/MySQL/MSSQL lab databases
pnpm docker:init             # once: docker/*.env with fresh secrets; never overwrites
pnpm docker:up               # build + start + wait healthy → http://localhost:3000
pnpm docker:e2e              # Playwright in a container, incl. a live PG→PG run
pnpm docker:cli              # interactive CLI inside movy-net
pnpm docker:scale 1          # runner-large replicas (0 by default)
pnpm docker:up:provisioner   # + docker-compose.provisioner.yml: the console starts runners itself
pnpm docker:down             # removes provisioned runners first, then `compose down`
```

**Compose rules** (`docker-compose.yml`, `docker/`):
- One image (`docker/Dockerfile`, target `runtime`) serves web, the runner agents and the
  CLI. `migrate` and `seed` use the `build` target because drizzle-kit and tsx are
  devDependencies.
- **Inside the stack, databases are service names** (`pg-lab:5432`). `localhost` in a
  connection means the web container itself.
- The `e2e` service uses `network_mode: service:web`. The session cookie is `Secure`,
  and a browser sends it over plain HTTP only to `localhost`, so at `http://web:3000`
  sign-in would silently not stick. Do not "fix" this by weakening the cookie.
- Compose never reads the root `.env`, which belongs to the CLI. Its env files are
  `docker/{movy,meta-db,lab,cli,runner}.env`, and regenerating `NUXT_ENCRYPTION_KEY` makes
  every saved connection undecryptable, which is why `docker:init` refuses to overwrite.
  It creates only the files that are missing, so re-running it after a pull is safe.
- **`web` runs no migration** (`MOVY_EMBEDDED_RUNNER=false`). `runner-default` (one
  replica) and `runner-large` (zero) run `apps/runner/dist/agent-main.js` with
  `init: true` (a zombie runner would pass the liveness check) and a 2-minute
  `stop_grace_period` (= drain). **A runner gets `docker/runner.env` only** — the
  `movy_runner` role and the encryption key, never `movy.env` with the owner's password
  and the session secret. `migrate` creates that role and its grants after the migrations
  (`packages/db/scripts/runner-role.ts`, `RUNNER_GRANTS`).
- `docker-compose.provisioner.yml` mounts the Docker socket into `web` (root on the host:
  opt-in only) and turns on `MOVY_PROVISIONER=docker` and auto mode. A clone is copied from
  a container labelled `movy.runner-template`, takes its class's limits, carries no Compose
  labels (so Compose never counts it) and exits after 10 idle minutes; the sweeper removes it.

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

packages/db/            # @movy/db — metadata DB: Drizzle schema, migrations, createDb(), secret crypto
apps/cli/               # @movy/cli — interactive command-line surface
apps/runner/            # @movy/runner — forked per run; src/agent/ is the host side (run control)
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

To add a new database, implement `DatabaseAdapterSet` and register it plus any cross-DB translators/migrators in `buildRegistry()` (`packages/core/src/composition/build-registry.ts`), which every surface calls. Adding engine `n + 1` costs `2n` new type maps and `2n` new translators — see `docs/adr/0001-direct-pair-type-translation.md`.

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

**Step 9 reads the destination's rows, not the source's counter alone.** A
PostgreSQL sequence or an MSSQL IDENTITY is reseeded from `MAX(col)` on the
DESTINATION, because a source restored by a dump that copied rows without advancing
its sequences carries a counter below its own `MAX(id)` — copying that verbatim hands
the destination the duplicate-key failure the migration was supposed to leave behind.
**PostgreSQL is the only destination where this is fatal**: an explicit-id `INSERT`
never advances a sequence, whereas InnoDB and `IDENTITY_INSERT` both carry their
counters along as rows load. On the other two the reset is the safety net, not the
mechanism.

The source counter stays in as a FLOOR, never discarded: a live sequence normally runs
AHEAD of `MAX(id)` — every rolled-back insert burns a value — so PG takes
`GREATEST(source next, MAX + 1, START)` and the step can only move a counter forward.

`COLUMN_SEQUENCES_SQL` resolves PG's sequences from the DESTINATION catalogue in
**both** shapes PostgreSQL records them: the `pg_depend` ownership a `serial` or
identity column has, and the default-expression dependency that is all a column
created by Movy's own `CREATE TABLE` has. Matching only the first missed exactly the
tables this tool creates. Reading the destination is also what makes the step work for
a MySQL or MSSQL source, whose inspectors report no sequences at all. Sequences no
column backs have no `MAX()` to read, so those still copy the source's `last_value`;
tables outside the migration set are left alone.

The MSSQL reseed reads the destination for a second reason: `SELECT MAX([id]) FROM
[users]` is a syntax error on a MySQL or PostgreSQL source, so querying the source
there warned and reseeded nothing for the entire MySQL→MSSQL Pair.

**Auto-increment crosses engines as a flag, never as a default.** Each engine spells
"this column numbers itself" differently, so `ColumnSchema.autoIncrement` carries the
meaning and each synchronizer spells it natively: MySQL `AUTO_INCREMENT`, MSSQL
`IDENTITY(1,1)`, PostgreSQL `GENERATED BY DEFAULT AS IDENTITY` (an integer with no
default only; a `serial` keeps its `nextval()`). The PG inspector sets the flag for a
`serial` and for an identity column; MySQL's and MSSQL's always did.

`carryAutoIncrement` (`application/use-cases/carry-auto-increment.ts`), run by
`SyncSchemaUseCase` **before** type translation, settles the rest for cross-engine Pairs:
- A `nextval()` default is dropped for a non-PG destination. It names a sequence that
  does not exist there, and MySQL rejects it outright — before this, **PG→MySQL failed
  on the first table of any schema with a `serial`** (found by the Compose live e2e).
- MySQL allows one auto column, and it must lead a key, so only the primary key's first
  column keeps the flag; MSSQL keeps its first; PG keeps all. A column that loses it keeps
  its copied values, and the run logs a warning naming it.

Re-running into a populated destination needed two more fixes, both in the diff:
- **A primary key is matched by type** (`constraintKey()`), never by name. MySQL calls
  every one `PRIMARY` and PG `<table>_pkey`, so by name each cross-engine re-run dropped
  the destination's key — refused by PG under a foreign key, and by MySQL under an
  AUTO_INCREMENT column.
- **A column alteration whose translated type is the column's current type is dropped**
  by `SyncSchemaUseCase`. The synchronizers diff raw source type names (`integer`)
  against the destination's (`int`), so every column used to be MODIFYed on every
  re-run. Compared by base name, so a length-only change across engines goes unseen.

`live-migration.spec.ts` proves PG→MySQL and MySQL→PG live, fresh and re-run, with the
counters checked: a MySQL→PG `orders.id` is an identity resuming at `MAX + 1`.

**SQL Server as a destination** (fixed 2026-10-22; found by the same spec). Four bugs
stacked, each hidden by the one before it:
- `MssqlConnection.getClient()` pinned no session — mssql's `pool.connect()` resolves to
  the pool itself — so it now opens a **one-connection pool** of its own, and `release()`
  closes only that.
- mssql's `query()` always goes through `sp_executesql`, and a `SET` inside it reverts on
  return, so `SET IDENTITY_INSERT … ON` never held for the INSERT after it on any
  connection. **The client sends parameterless statements as a batch** (`request.batch`).
- A 500-row batch is 2,500 parameters at five columns; SQL Server's cap is 2,100.
  `insertMssqlRows` (`migration/mssql-insert.ts`) splits every INSERT to at most 2,000.
- `buildColumnDef` dropped `characterMaxLength`, and SQL Server reads a bare `nvarchar` as
  `nvarchar(1)`. It now appends the length, `(max)` past 4,000 / 8,000.

**Numeric precision crosses engines in the type string.** The PG inspector reported
`numeric(12,2)` as bare `numeric`, so MySQL created `decimal(10,0)` and SQL Server
`numeric(18,0)` — rounding away every cent while the row counts still matched. It now
reports `numeric(12,2)`, as the MySQL and MSSQL inspectors always did. **A row-count
comparison cannot catch this kind of loss**; the fix was found by reading the column.

**A self-reference is not a cycle.** `TableMigrationPlanner` counted
`customers.referred_by → customers` as an incoming edge, so `customers` never reached
in-degree zero and it and every table below it fell into the unordered cyclic level —
`order_items` loaded before `orders`. Self-references are skipped; `cyclicTables` now
lists only real multi-table cycles, which is what both of its warnings describe.

A failed table also gives the run an error now: `run_finished` carries `TablesFailed`,
naming up to three tables and why, so the run page no longer says "failed" and nothing else.

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

The web app **queues** each run; a runner agent claims it, forks the runner, and
rebuilds run state from its events. Five tables: `migration_definitions` (the saved, repeatable migration)
and `runs`, plus `run_events` and the two projections `run_steps` /
`run_table_progress`. Two more hold comparisons: `validation_runs` and
`validation_table_counts`.

| Module | Purpose |
|--------|---------|
| `apps/runner/src/agent/run-projection.ts` | **Pure.** Folds a batch of events into row patches. No I/O, so every ordering rule is testable against the recorded fixture. |
| `apps/runner/src/agent/event-writer.ts` | Batches events (200 / 250ms) into one transaction per run. Never rethrows: a failed metadata write must not kill a live migration. |
| `apps/runner/src/agent/journal-tailer.ts` | Reads a journal forward from a `seq` cursor; tolerates a half-written trailing line. |
| `apps/runner/src/agent/run-manager.ts` | Forks the runner `detached`, feeds IPC to the writer, cancels, and re-attaches on boot. |
| `apps/runner/src/agent/ingestion.ts` | The unscoped ingestion helpers the manager uses (`applyProjection` and friends). |
| `server/repositories/runs.repo.ts` | Org-scoped reads, and the retention sweep. |
| `server/runs/index.ts` | Wires the agent modules above to `useDb()` and the hub. Imports `@movy/runner/agent`. |

**Run control lives in `apps/runner/src/agent/`, not in the web app** (phase 1 of
`docs/runner-service-plan.md`). The embedded agent in the web console and the standalone
`movy-runner-agent` (`src/agent-main.ts`, phase 6) run the same modules. The schema, migrations, `createDb()`
and the connection-secret crypto are `@movy/db`, which both share.
`server/db/schema/index.ts`, `server/db/client.ts` and `server/utils/crypto.ts` re-export
it, so the web app's imports did not move. `pnpm db:migrate` / `db:generate` run in
`packages/db`. Like `@movy/core`, `@movy/db` and `@movy/runner/agent` resolve to their
built `dist` outside the test suite, so **`pnpm build` after editing them** — vitest
aliases all three to source.
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

**Every settlement is announced by the database, not by the code that wrote it.** The
`runs_settled_notify` trigger (migration 0009) sends `movy_run_settled` whenever a run's
status becomes terminal. Most settlements carry no event — a fenced or crashed runner,
a refused spec, the sweeper — and only the sweeper's statement used to notify, so the
others left the page on "running" forever. Do not add hand-written NOTIFYs for it. On a
LISTEN reconnect the console re-reads every watched run (`SettledStatusFeed.resync`),
because a notification sent meanwhile is gone.

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

### The queue and the runner agent (phase 2 of `docs/runner-service-plan.md`)

`runs` is the queue: launching inserts a `queued` row and its **sealed spec**
(`run_specs`) in one transaction, and a runner agent claims it with
`UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`. `queued → running`
happens at the claim. No Redis, no BullMQ: Postgres was already there.

| Module | Purpose |
|--------|---------|
| `apps/runner/src/agent/queue-store.ts` | Every queue statement — register, claim, take spec, heartbeat, settle, queued cancel, re-attach list, sweep — over a two-method `SqlClient` that `pg.Pool` and PGlite both satisfy. |
| `apps/runner/src/agent/runner-agent.ts` | `RunnerAgent`: claims up to its slots, forks through `RunManager`, heartbeats, fences, drains. |
| `apps/runner/src/agent/run-spec-envelope.ts` | Seals and opens the spec: `encryptSecret` with `specAad(orgId, runId)`, versioned. |
| `server/runs/index.ts` | `useRunnerAgent()` — the **embedded** agent, on unless `MOVY_EMBEDDED_RUNNER=false`. |
| `server/plugins/embedded-runner.ts` / `runner-sweeper.ts` | Start/stop the embedded agent; settle lost runs every 10 s. |

- **The spec is sealed at enqueue and deleted at claim.** It holds two passwords, so it
  is encrypted for one org and one run (`specAad`), and the claiming agent reads it with
  `DELETE … RETURNING`: there is no resume, so nothing ever needs it twice. An unknown
  `spec_version` fails the run `RunnerIncompatible`, naming both versions. A simulated
  run carries `{simulate, speed}` only; the agent resolves the fixture on its own host.
- **The lease is the only proof a run is alive.** Every 5 s the agent's heartbeat
  extends `lease_expires_at` (30 s) on the runs it holds and gets them back. The
  sweeper — one web replica at a time, via a transaction-scoped advisory lock in a
  single statement — settles a run whose lease expired `RunnerVanished` (`cancelled`
  if a user had asked), and shows silent runners offline.
- **Fencing: a run missing from the heartbeat's answer is stopped at once.** The
  sweeper has told the ledger its destination is free; a runner that kept writing would
  be the harm. **Fencing is SIGKILL** (`RunManager.terminate`), never SIGTERM: the runner
  turns SIGTERM into the user's cancel, which is checked only between operations, so a
  fenced run inside a COPY kept writing. It reaches a run the agent recovered after a
  restart too, by its stored pid: `reattach()` names the followed runs that hold a lease
  (`leased`), and the agent owns them. Only a run forked before migration 0004, which
  has no lease at all, is exempt.
  **A beat judges only the runs live BEFORE its query.** `wake()` claims on another pool
  connection while the heartbeat is in flight, and the statement's snapshot cannot see a
  claim committed after it began: judged by the live set read afterwards, such a run was
  terminated as swept, and one still between claim and launch dropped out of `owned`
  and was never fenced at all. Both now wait for the next beat.
- **A cancel that fails to forward is unmarked**, so the next beat that sees
  `cancelling` sends it again; the heartbeat does not await it, so it never rejects.
- **A drain stops claiming before it waits for anything** (`stopClaiming()`): a shutdown
  waits on its probes first, and a run claimed meanwhile would be left behind.
- **A queued run is cancelled outright** — conditional on `status = 'queued'`, so it
  cannot race a claim: exactly one of the two statements matches the row. A running one
  goes `cancelling`; the embedded agent forwards it at once, and the owning agent's
  heartbeat finds the row anyway.
- **`RunnerAgent.cancel` acts only on a run live on its host.** `RunManager.cancel` on a
  run it does not hold sees no process and settles it `RunnerGone` — true when there was
  one host, a lie about another runner's live run once there are several.
- **Re-attach never touches a queued run.** It lists the agent's own unsettled runs and
  any ownerless one from before 0004 (`reattachableRuns`); the old query listed every
  non-terminal run, which would have settled every waiting run as vanished on boot.
- **The embedded agent's id is `embedded-<hostname>`** (or `MOVY_RUNNER_ID`), stable
  across restarts of the same host, so it re-attaches to its own runs. On start it
  re-attaches and heartbeats **before** it claims, extending those leases ahead of any
  sweep. Its start is retried every 5 s until it succeeds (`startWithRetry`), as the
  standalone agent's is: tried once, a meta-db still booting left a console that never
  claimed a run. Its class and slots are read by the runner service's own rules
  (`readEmbeddedRunnerConfig`); an invalid value leaves it OFF with the reason logged —
  a runner service exits 64 on the same value — never on a default nobody chose.
- **One run per destination, across orgs** (phase 4). `runs.target_lock_key` is
  sha256(engine, host, port, database), set at launch, null for a replay, never
  serialised. The claim skips a queued run whose key a `running`/`cancelling` run holds;
  the partial unique index `runs_target_busy_uq` refuses the second of two simultaneous
  claims, and the claim asks again. Why a run is still queued (`no_runner`,
  `destination_busy`, `runners_busy`, `starting`) is derived per request
  (`server/runs/queue-state.ts`), never stored; another org's run is never named.
- **Runner classes come from `MOVY_RUNNER_CLASSES_FILE`** (`docker/runner-classes.json`),
  parsed strictly by `parseRunnerClassesFile` (unknown keys rejected, one default) and
  upserted at boot. **One name rule** (`isRunnerClassName`) for the file,
  `MOVY_RUNNER_CLASS` and a saved definition, so a name one accepts another cannot refuse
  later; `web` is reserved, because Test and Preview read `via: 'web'` as the console.
  Counts are capped at the integer columns that store them. A class the file drops is kept with `configured = false` — runs and
  definitions reference it — and offered for nothing new. A run's class is the body's,
  else its definition's, else the default (`chooseRunnerClass`).
- **The size suggestion reads bytes, not rows**: optional
  `ISchemaInspector.getTableSizeEstimates`, which answers an empty map rather than
  throwing — a size picks a class, it never gates a migration. The preview carries
  `runnerSuggestion`; the review screen shows it as a hint, never a switch.
- **Test and Preview can run on a runner** (phase 5): `via: 'web' | <class>` on both Test
  routes and on preview. The executors are `@movy/runner/probes` (`testConnection`,
  `inspectForPreview`, and the scrubbing in `safe-error.ts`, which web re-exports), so both
  paths say the same sentence. A probe is a `runner_probes` row: sealed with
  `probeAad(orgId, probeId)`, cleared at claim, answered by the agent's `ProbeWorker` in its
  own slots (`probe_slots`), its result taken and deleted by the waiting request
  (`server/probes/run-probe.ts`). `NOTIFY movy_probe_done` wakes the request; it re-reads
  every second anyway, because a NOTIFY can be missed. No runner of the class online is an
  immediate 503 `no_runner`, never a wait; silence is a 504 and deletes the row. The test
  is recorded with `connections.last_test_via`. Compare stays in-request (decision 6).
  **A runner's answer is rebuilt, never cast** (`readProbeResult`): every runner writes
  through the one `movy_runner` role across orgs, and the result is served to a browser,
  so only the known fields survive and any other shape becomes a failure that says so.
  The run spec envelope and a probe request are checked the same way when opened.
- **A queued run cancelled outright emits no event**, so the run page applies the cancel
  response with `applyRunRow`, which only moves a status forward.
- **Events reach the browser through the database, whichever process ran the run** —
  see *The live stream*: there is no in-process shortcut, so an embedded agent and an
  external one are indistinguishable to a client.

The queue SQL is tested against **PGlite with the real migrations**
(`apps/runner/tests/unit/agent/queue-store.test.ts`, harness in
`packages/db/tests/helpers/meta-db.ts`). What one connection cannot show is two agents
racing; `SKIP LOCKED` under true concurrency belongs to the Compose meta-db. PGlite is a
**root** devDependency on purpose: added to `@movy/db`, it split `drizzle-orm` into two
installed variants and broke type identity between packages.

### Runner services (phase 6)

`apps/runner/src/agent-main.ts` (bin `movy-runner-agent`) is the agent as its own
process: the same `RunnerAgent`, `RunManager`, `EventWriter` and `ProbeWorker`, wired from
the environment (`readAgentConfig`, which refuses a bad value at boot, exit 64, rather
than default it). It listens on no port; it LISTENs on `movy_runs` (`{runnerClass}`, sent
at enqueue), `movy_run_cancel` (`{runId}`, sent by `requestCancel`) and `movy_probes`.

- **Its pool has a 30 s client-side query timeout and TCP keepalive.** Found by the
  partition step of the Compose gate: a query sent on a socket that died in a network
  partition never settles, `wake()` kept returning that `claiming` promise, and the agent
  heartbeated happily while never claiming again. Every agent statement is short.
- **It fences itself, on a deadline, not on an error.** Each owned run carries the time
  the request that last renewed its lease (claim or heartbeat) was SENT; the database
  stamped the lease no earlier, so the deadline can only be early. A 1 s timer
  (`checkLeases`) stops any run within `fenceMarginMs` (5 s) of `leaseMs` — never only
  after a heartbeat fails, because a query into a blackholed connection outlasts the
  lease, and the embedded pool has no query timeout at all. A run fenced while its spec
  was being read is never launched, and leases are checked once more synchronously
  before `launch`, so a claim answered past its deadline never starts. A recovered run
  counts as due until a beat here confirms it, and the timer is armed BEFORE the first
  beat: that beat awaits the claim loop, and a hung heartbeat must not shelter it.
- **Re-attach is scoped to its own runs** (`includeOwnerless: false`); ownerless pre-0004
  runs were forked by a web console and are the embedded agent's to adopt.
- **Idle exit only when provisioned** (`MOVY_RUNNER_PROVISIONED_BY`): no run AND no probe
  for `MOVY_RUNNER_IDLE_EXIT_MS` (10 min). A baseline replica never removes itself.
- **Provisioning** (`server/runners/`): `RunnerProvisioner` is `manual` (answers the
  command) or `docker` (Engine API over the socket, no client library). `POST
  …/runners/scale` needs a **platform operator**, never an org role (see below). The docker provisioner counts every clone not yet
  finished — created, booting or registered — by its container id (= the runner id, its
  hostname), and serialises scale-ups per class, so simultaneous clicks on one replica
  cannot pass `max_replicas`. Two web replicas asked within the same second can, by one (#10). **Auto mode**
  (`MOVY_AUTOSCALE=true`) runs on the replica that won the sweep: a class with queued work
  not blocked on its destination, no free slot and room under its cap, once per 60 s.
- **`StartRunner.vue`** is offered where `no_runner` is the reason: the queue notice and
  "Test from"/"Inspect from" on a class with nobody online. Absent, not disabled, for
  anyone who is not an operator (`/api/me` answers `platformAdmin`).
- **Platform operators are not org admins.** Orgs are self-serve, so an org admin is
  whoever created the org; one must never start shared runners or read their hostnames.
  An operator is a `platform_admins` row (granted at runtime, with who and when — the
  SaaS case) or an email in `MOVY_PLATFORM_ADMINS` (a self-hosted deploy, or a SaaS's
  first operator). `server/utils/platform-admin.ts` reads both from the database on every
  check, never from the session, and the runner hub re-reads them every refresh, so a
  revoked operator loses the runner ids within 5 s. The `movy_runner` role cannot read
  the table.

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
| `server/runs/run-event-feed.ts` | **Pure.** NOTIFY pointer → read `run_events` past a per-run cursor → `hub.publish`. Every ordering rule below lives here. |
| `server/runs/pg-listener.ts` | One dedicated, unpooled connection holding `LISTEN`; reconnects with backoff and reports it, so the feed can re-read. |
| `server/runners/runner-hub.ts` | Runner availability rooms, one per org and audience; refreshed on `NOTIFY movy_runners` and every 5 s while watched. |
| `server/runners/runner-summary.ts` | The panel's numbers: capacity across all runners, queue depth for this org only, runner ids for platform operators only. |

**The socket performs no authorisation.** A client POSTs
`/api/orgs/:slug/runs/:id/ticket` — an ordinary request that has been through
auth, org resolution, a permission gate and an org-scoped lookup — and redeems
the result. `roomKey()` is therefore reachable only with a `SubscriptionGrant`,
so nothing from the wire can reach a room name. Do not add a string-keyed join;
`socket-isolation.test.ts` asserts the source shape, not only the behaviour.

**Broadcast happens after the durable write — by construction now.** A client
reads its snapshot from the database and then goes live, so announcing an event
before it is queryable would leave a hole the client cannot detect. The agent's
`applyProjection` sends `NOTIFY movy_run_events '{runId, lastSeq}'` **inside the
same transaction** that stores the events, and Postgres delivers a NOTIFY only on
commit; the web's `RunEventFeed` then reads committed rows past its cursor. That
holds for an agent in any process, which `EventWriter.onFlushed` — a callback in
one process, now unused — never could. The payload is a pointer because NOTIFY is
capped at 8 KB and a log line can be longer.

For the same reason a peer joins its room *before* its snapshot is read, and the
socket handler awaits `feed.track(runId)` — which fixes the cursor at the stored
`last_seq` — before reading it: an overlap is a duplicate the client drops by
`seq`, which a gap is not. A run already tracked keeps its cursor; moving it
forward for a second peer would skip events for the first.

**NOTIFY has no replay**, so when the LISTEN connection drops and comes back the
feed re-reads past every cursor (`resync`). Reads for one run never overlap; a
notification that arrives mid-read folds into one more read. Every web replica
listens and fans out to its own sockets; nothing coordinates them. **A failed read
retries on its own** (2 s, while anyone here watches the run): the read that fails may
be the one holding `run_finished`, after which no notification for that run ever
comes. The cursor moves only after the fan-out returns, so a throw there re-reads
rather than skips.

**Runner availability** (`/_ws/runners`, `POST /api/orgs/:slug/runners/ticket`) is a
second hub with its own ticket store, so a run-stream ticket can never open it. It
follows the same rules: a server-minted grant, a private `roomKey`, a handler that
decides nothing, roles revalidated on every refresh. Capacity is counted across all
runners (they are platform-wide); the queue depth is this org's only; runner ids are
hostnames and go to the operator room only — decided by operator status, never by org
role. A heartbeat does not NOTIFY — it happens
every 5 s per runner — so the hub refreshes on an interval while anyone watches and
sends a frame only when it changed.

**A demotion reaches a live socket** within one 5s revalidation interval — one
batched query for all subscribers, deduplicated per person. The subscriber's
cohort is on the SNAPSHOT as well as on `cohort_changed`: a viewer is never
demoted mid-session, so without it they never learn why their log pane is empty.

### The run UI

`shared/run-wire.ts`, `shared/definition-wire.ts` and `shared/connection-wire.ts`
(Nuxt 4's `shared/`,
imported by both halves) are the one declaration of the wire contract — frames, row shapes, step ids and labels. The
serializer's return types are annotated with it, so a field the server stops
sending is a type error in the client. It restates the nine step ids rather than
importing `MIGRATION_STEP_ORDER`, because `@movy/core` is CommonJS and the client
bundle cannot import it; `step-order.test.ts` fails if the copy drifts.

**The Nitro server bundle INLINES `@movy/core`**, despite `nitro.externals.external`
naming it: in Nitro 2.13 that list only stops a module being forced inline, and a
workspace package resolves outside `node_modules`. Inside the bundle core's CommonJS
`require`s of the drivers become ESM namespace imports, which is why `unwrapMssql`
exists — `mssql`'s exports are invisible to Node's lexer, so every in-request MSSQL call
(Test, list databases, preview, compare) failed in a production build only.

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

### The connections screen

| Module | Purpose |
|--------|---------|
| `shared/connection-wire.ts` | The connection shape, the engine list and its default ports. `toPublicConnection` is annotated with it. |
| `app/utils/connection-form.ts` | **Pure.** Form values → request body, and the delete gate. Both rules below live here, so both are tested without a browser. |
| `app/components/connections/ConnectionForm.vue` | One form for create and edit. |
| `app/components/connections/DeleteConnectionPanel.vue` | The typed confirmation. |

**One drawer per row, keyed `{ id, kind }`.** Four things open under a
connection — databases, edit, delete, and why the last test failed — and they
are mutually exclusive by nature. A single nullable pair makes that
structurally true rather than true until someone adds a fifth.

**A blank password field means "keep the stored one".** It cannot mean anything
else: the stored password is never sent to a client, so the edit form has
nothing to prefill it with. `toConnectionInput` therefore OMITS the key rather
than sending `''` — the PATCH handler distinguishes the two by length today and
a future one might not. For the same reason the ENGINE is fixed once saved: the
handler does not accept it, and changing it would leave every field beneath it
describing a different dialect.

**Deleting takes the connection's name, typed.** Opening the panel is the first
confirmation and a click can be a misfire; typing the name cannot be satisfied
by muscle memory, and it forces a reader to look at which row they are on.
Trimmed but case-sensitive — two connections can differ only in case. A
connection a definition still names is refused by the FK with a 409 counting
them, which the panel shows in place.

**A failed test expands its own reason under the row**, and the `failed` badge
toggles it back — the sentence `describeConnectionFailure` writes is the outcome
of pressing Test, and it spent Phase 2 in a `title` tooltip. The drawer reads
`lastTest.error` from the refreshed list, not the POST response, so a reload
shows the same string.

### The runner (@movy/runner)

`apps/runner` is forked once per run by a runner agent. It owns what the core
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

`live-migration.spec.ts` is the exception: REAL PG→PG, MySQL→PG, PG→MySQL, PG→MSSQL and
MySQL→MSSQL runs against the Compose lab, each checked by a row-count comparison. It skips unless `MOVY_E2E_LIVE` is set,
which only `pnpm docker:e2e` does, and it finds its connections by the names
`seed-lab.ts` saves. `MOVY_E2E_EXTERNAL_SERVER` turns off Playwright's own `webServer`.

**The mid-run reload is the point.** Everything else is covered by unit tests against
mocks; what none of them can cover is a real browser losing its WebSocket, re-fetching a
snapshot from the database, and continuing from the same `seq` without a gap or a
duplicate.

Two traps, both cost an hour once: sign-in must wait for hydration
(`waitForLoadState('networkidle')`) or `fill` writes into inputs Vue has not bound yet
and the submit posts nothing; and authenticated API setup must use `page.request`, not
the top-level `request` fixture, which carries no session cookie and 401s in a way that
looks like a permission bug.
