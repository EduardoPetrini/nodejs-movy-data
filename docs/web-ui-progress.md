# Web UI — progress and handoff

Working branch: **`feat/runner-service-phase-0`** (runner service plan R0–R6).
Plan: `~/.claude-personal/plans/let-s-a-web-ui-vectorized-codd.md` — **no longer
on disk** (checked 2026-10-22). Every phase it described is closed; this file is
now the only record of them.

> This covers the **web UI** work. `docs/implementation-plan.md` remains the
> CLI-side plan (engine roadmap, type maps, Pair status) and is unaffected.

## Working agreement — keep this file true

**This file is the handoff.** Whoever picks the work up next reads it instead of
re-deriving the state from the diff, so it is updated twice per phase, not once
at the end:

1. **When a phase starts** — flip its row in the status board to `IN PROGRESS`,
   date it, and write down what "done" will mean for it.
2. **When a phase completes** — flip the row to `DONE`, move the detail into a
   `## Phase N — …` section below (decisions that are load-bearing, bugs the
   work found, what was verified and how), and re-cut the *Remaining work* list.

A phase abandoned or descoped is recorded too, with the reason. An unrecorded
phase is indistinguishable from one that was never started.

## Status board

*Last reviewed: 2026-10-27. 1637 unit tests green; Compose E2E green at 28/28 after all three PR #8 review passes (re-run 2026-10-27, migration `0009` applied); host `pnpm test:e2e` (embedded agent) 14/14, same date. Work after this release is tracked in GitHub issues #9–#21.*

| Phase | State | Notes |
|-------|-------|-------|
| 0 — monorepo restructure | **DONE** | three workspaces, history preserved |
| 1 — core made drivable | **DONE** | event contract, sinks, `--json-events` |
| 2 — web shell, auth, orgs, connections | **DONE** (2026-09-08) | org creation, members, invitations, org switcher |
| 3a — live timeline, simulated | **DONE** | runner, RunManager, socket, UI |
| 3b — real runs | **DONE** (2026-09-08) | definitions, PairSelector, preview; real PG→PG verified |
| 4 — history, replay, stats, drift | **DONE** (2026-09-08) | keyset ledger, comparisons, drift, org home; verified live |
| 5 — hardening | **DONE** (2026-09-09) | redaction, cancellation, E2E, retention, taxonomy, docs |
| 5r — review of Phase 5 | **DONE** (2026-09-09) | five defects found in `1329ca1` and fixed in `6f13fcd` |
| — connection lifecycle | **DONE** (2026-09-09) | edit, delete behind a typed confirmation, failure reason inline |
| — sequence reseed + test before save | **DONE** (2026-09-17) | step 9 reads the destination's `MAX()`; create form tests unsaved credentials |
| R0 — Compose foundations (runner service plan) | **DONE** (2026-10-22) | `docker-compose.yml`: meta-db, migrate, seed, web, three seeded lab DBs, CLI, e2e. Live gate moved PG→MySQL → PG→PG + MySQL→PG after it found the auto-increment gap; see *R0* below. Next: R1 (extract `@movy/db`) |
| R1 — extract `@movy/db`, move run control into `apps/runner` | **DONE** (2026-10-22) | no behaviour change; web still forks. Gate met: moved tests changed import paths only, 1262/1262, `pnpm docker:e2e` green. See *R1* below. Next: R2 (queue and agent) |
| R2 — queue and agent | **DONE** (2026-10-22) | migration `0004`; agent claims from `runs` (SKIP LOCKED), heartbeats a lease, fences, drains; sweeper settles lost runs; web enqueues instead of forking, embedded agent by default. Gate met: `pnpm docker:e2e` 13/13 on the embedded agent. See *R2* below. Next: R3 (NOTIFY bus) |
| R3 — NOTIFY bus and runner availability | **DONE** (2026-10-22) | events reach the hub through `LISTEN movy_run_events` (the in-process `onFlushed` path is gone); runners socket, ticket and panel on the org home and runs page. See *R3* below. Next: R4 (destination lock and classes) |
| R4 — destination lock and runner classes | **DONE** (2026-10-23) | one run per destination (`target_lock_key`, migration `0005`) and why a run is queued; classes from `MOVY_RUNNER_CLASSES_FILE`, a class per definition and a Runner selector (`0006`); source size in bytes on the preview and a class suggestion. Gate: `pnpm docker:e2e` 19/19. See *R4* below. Next: R5 (probes) |
| R5 — probes: Test and Preview from a runner | **DONE** (2026-10-23) | migration `0007` (`runner_probes`, `runners.probe_slots`, `connections.last_test_via`); executors in `@movy/runner/probes` shared by the in-request path and the agent's `ProbeWorker`; `via: 'web' | <class>` on both Test routes and on preview; 503 `no_runner`, 504 on silence; "Test from" and "Inspect from" selectors. Gate: `pnpm docker:e2e` 23/23. See *R5* below. Next: R6 (runner services) |
| R6 — runner services and provisioning in Compose | **DONE** (2026-10-25) | `movy-runner-agent` as `runner-default`/`runner-large` under the least-privilege `movy_runner` role (`docker/runner.env`); `web` no longer forks; NOTIFY wakes agents on launch and cancel; `manual` and opt-in `docker` provisioners, Start a runner (`runner:scale`), auto mode, idle exit. Found and fixed: an agent wedged after a network partition (query timeouts), clone swap limit. Gate: the plan's Verification list in Compose, `pnpm docker:e2e` 26/26. See *R6* below. Next: R7 (Kubernetes) or R8 (runner classes in the UI) |
| — PR #8 review fixes | **DONE** (2026-10-25) | platform operators (`platform_admins`, migration `0008`, `MOVY_PLATFORM_ADMINS`) replace the org-admin `runner:scale`; heartbeat/claim race in fencing; live feed retries a failed read; embedded agent retries its start and refuses bad config; one class-name rule; runner answers rebuilt, not cast; provisioner cap under concurrency; drain stops claiming first. See *PR #8 review fixes* below. Gate re-run after all three passes (2026-10-27): `pnpm docker:e2e` 28/28, host `pnpm test:e2e` 14/14 |

### Remaining work

**Phase 5 is closed** (2026-09-09). Write-up under *Phase 5 — hardening* below.
All five phases are now DONE. What is left is not a phase:

**A comparison of a large database will still time out.** `POST …/validations`
counts synchronously inside the request: `COUNT(*)` per table, no child
process, no event stream. Right for the fixtures (150ms for 315k rows across
five tables), wrong for a database where one `COUNT(*)` takes minutes. The
`running` status and the `finished_at` / `duration_ms` columns are already
shaped for an out-of-band version; nothing else is. **Explicitly descoped from
Phase 5** and recorded as such at the start: it needs a second runner mode
rather than hardening, and doing it there would have crowded out seven items.
Move it behind the runner before pointing this at anything large. Tracked in [#13](https://github.com/EduardoPetrini/nodejs-movy-data/issues/13).

**A stalled run is reported to the server log and nowhere else.** The watchdog
deliberately does not settle a live-but-silent run — that would free the org's
concurrency slot and let a second run launch into a destination the first is
still writing to. But surfacing it in the UI needs a `stalled` flag on `runs`
and a migration, which Phase 5 did not add. Today an operator learns about it
from `console.warn`. Tracked in [#14](https://github.com/EduardoPetrini/nodejs-movy-data/issues/14). The review closed the other half of this: until `6f13fcd`
the watchdog only ever watched runs ADOPTED after a restart, never the ones
this host forked itself. See *Bugs found reviewing Phase 5* below.

**Coverage is 63.35 / 48.35 / 67.04 / 64.09** against a target of 80. Phase 5
moved every axis up (from 62.04 / 46.46 / 65.94 / 62.82), the review moved each
up again, and the thresholds are re-ratcheted to the floor — set by NAME, since
the report prints statements/branches/functions/lines and the `thresholds`
object does not list them in that order. The largest remaining gaps are
`apps/cli/src/presentation/cli/cli.ts` at 0% and the Vue components, neither of
which is unit-tested at all. Tracked in [#17](https://github.com/EduardoPetrini/nodejs-movy-data/issues/17).

**No `prefers-contrast` or screen-reader pass.** Phase 5 did keyboard and focus:
a skip link, focus rings verified in a browser, and three Playwright tests. It
did not audit with a screen reader, and `docs/agents/` records no commitment to. Tracked in [#18](https://github.com/EduardoPetrini/nodejs-movy-data/issues/18).

**Known bugs, tracked.** One open, CLI-side:
[#4](https://github.com/EduardoPetrini/nodejs-movy-data/issues/4) `MssqlQueryAnalyzer`
and `MysqlQueryAnalyzer` are unreachable — still `needs-triage` on implement
portable query migration versus delete them.
[#3](https://github.com/EduardoPetrini/nodejs-movy-data/issues/3) (MSSQL reseed
assumed an `id` column) and [#5](https://github.com/EduardoPetrini/nodejs-movy-data/issues/5)
(query migration crashed on a non-PostgreSQL destination) were fixed in code
earlier and left open on GitHub; both closed 2026-10-22.

**~~Auto-increment is not carried across engines.~~ Fixed 2026-10-22** — see
*Fix — auto-increment across engines* below.

**~~MSSQL as a destination is broken for real data.~~ Fixed 2026-10-22** — see
*Fix — SQL Server as a destination* below.

**Comparisons count rows, never values.** A PG→MySQL run rounded every price to a
whole number and its comparison still read 100%. Found by reading the column. Tracked in [#15](https://github.com/EduardoPetrini/nodejs-movy-data/issues/15).

**The test-before-save endpoint has no unit test.**
`connections/test.post.ts` (2026-09-17) was verified by hand only. See the
section at the end of this file. Tracked in [#16](https://github.com/EduardoPetrini/nodejs-movy-data/issues/16).

---

## What exists now

```
packages/core/   @movy/core    the hexagon; CommonJS, no I/O entry points
apps/cli/        @movy/cli     the original interactive CLI
apps/runner/     @movy/runner  the run driver: argv, stdin, signals, IPC, journal
apps/web/        @movy/web     Nuxt 4: orgs, RBAC, connections, definitions, runs
```

`pnpm` workspaces. 1233 unit tests, plus 8 Playwright E2E behind `pnpm test:e2e`.
Coverage 63.28 / 48.02 / 66.99 / 64.06 over core + CLI + runner, ratcheted
upward only; `apps/web` ratchets separately so a young app neither dilutes the
core number nor hands it a free jump.

### Phase 0 — monorepo restructure
Split `src/` into three workspaces. 106 renames, so `git log --follow` still
works. Removed 12 compiled `.test.js` files committed by accident in `db37750`.

### Phase 1 — the core made observable
`MigrationOrchestrator.run()` and `MigrateDataUseCase.execute()` take an optional
trailing `ctx?: MigrationRunContext` (`{ runId, emit, signal }`). Optional is
load-bearing: it broke no call site and no test mock. The nine
`MIGRATION_STEP_ORDER` steps are now typed events; `SinkLogger` in the
`TeeLogger` puts all ~60 existing `logger.*` calls on the same stream untouched.

Also: `buildRegistry()` moved into `packages/core/src/composition/`,
`listSupportedPairs()` reports 9 Done / 7 Planned, `listDatabases`/`listTables`
on all three Adapter Sets, MSSQL row-count validation, absolute log paths, and
optional `ssl`/`schema` on `ConnectionConfig`.

### Phase 2 — the web foundation
Orgs, three roles, encrypted connections, the design system, and connections
CRUD + test + database/table listing. Verified end to end against the live
PostgreSQL server.

**Closed 2026-09-08** with the half that was missing: an org could be reached
but never created, and the `invitations` table was referenced by nothing. Full
write-up under *Phase 2 — onboarding* below.

### Phase 3b — real runs
**Closed 2026-09-08.** A run can now be saved, reviewed and repeated, and a real
PostgreSQL→PostgreSQL migration has been driven end to end through the browser.

`migration_definitions` (migration `0002`), `DefinitionsRepository`, CRUD behind
`definition:read` / `definition:write`, `PairSelector`, `POST …/runs/preview`,
and a `/o/:slug/runs/new` review screen. `runs` gained `definition_id` and its
`mode` now comes from the definition instead of the literal `'full'`.

**Verified live** against the PostgreSQL on :5432, `movy_fixture_src` →
`movy_fixture_dst` (5 tables, 315k rows, FK-related). 500 rows were deleted from
the destination's `order_items` first, so a pass could not be mistaken for a
no-op:

- Preview reported 315,000 estimated rows, load order
  `audit_log, customers, products, orders, order_items` (FK parents first) and
  the warning naming all five tables that would be emptied.
- The run finished `succeeded` in 805 ms, nine steps green, 315,330 rows.
- Every destination count matched the source exactly afterwards — including the
  500 rows put back — proving the destination really was emptied and reloaded.
- Launched a second time from the browser, `24a2e40d`: same result, with the
  timeline, table grid and log stream drawing live.

Refusals were exercised against the running server: query-mode launch → 422 with
the reason, same-database run → 400, duplicate definition name → 409, deleting a
connection two definitions use → 409 naming the count.

### Phase 5 — hardening
**Closed 2026-09-09.** A password can no longer reach a screen, Cancel actually
cancels, the event store is bounded, failures say which failure they were, and
the end-to-end path is a test rather than a memory. Full write-up under
*Phase 5* below.

`RedactingSink` in `composeSink`, `classifyConnectionError`, `throwIfCancelled`
and `WorkerPool.terminate()`, a per-run log cap and a retention sweep,
`server/utils/safe-error.ts`, a skip link, Playwright with 8 specs, ADR 0002 and
ADR 0003, and the web vocabulary in `CONTEXT.md`.

### Phase 4 — history, comparison and drift
**Closed 2026-09-08.** The ledger pages properly, a comparison is a stored
artefact rather than a screenful, drift is read the same way before and after a
migration, and the organisation finally has a home page. Full write-up under
*Phase 4* below.

`validation_runs` + `validation_table_counts` (migration `0003`),
`ValidationsRepository`, `StatsRepository`, keyset pagination on both ledgers,
`GET …/stats/summary`, `SchemaDiffView` extracted from `PreviewPanel`,
`CountComparisonTable`, `DurationSparkline`, and the pages `/o/:slug` and
`/o/:slug/compare`. Sign-in now lands on the org home instead of `/connections`.

---

## Phase 3b — decisions

**Query mode can be SAVED but not LAUNCHED, and those are two different gates.**
`MigrateQueryUseCase` takes no `MigrationRunContext` and emits nothing — not
`run_started`, not a step, not a row count — so a web run of it would show nine
hollow nodes indistinguishable from a hang. But the SQL is still worth writing
down and running from the CLI, and refusing to save it would make the `mode`
column a lie. Hence `saveAvailability` (permissive) and `modeAvailability`
(strict) in `shared/pair-capability.ts`, with a test asserting the second is
never laxer than the first.

**One module owns both the decision and its wording.** `shared/pair-capability.ts`
is imported by the form, by `prepareDefinition` and by `resolveRunTarget`. The
plan's rule is "disabled with the reason shown, never a runtime failure", and
that is only achievable if the UI's tooltip and the API's 422 come from the same
function. A rule split across the two halves ends with the UI offering something
the API refuses.

**Preview and launch resolve through the same function.** `resolveRunTarget()`
settles definition, connections, databases and mode for both. A review screen
describing a different migration from the one the button starts is worse than no
review screen, because it is trusted.

**One `POST …/runs/preview`, not the plan's `/preview/diff` + `/preview/plan`.**
Both need the same two connections and the same full schema inspection; splitting
them would inspect two production databases twice to draw one screen. Deviation
from the plan, recorded deliberately.

**A missing destination database is information, not an error.** Preview asks
`listDatabases()` rather than connecting and reading the failure, because "the
database does not exist" and "the credentials are wrong" are not reliably
distinguishable from a driver error — and guessing wrong tells someone their
database is missing when their password is stale. Absent, it diffs against an
empty schema, which is exactly what the run does after step 1. Refusing here
would fail precisely when a preview is most wanted: the first migration.

**Definitions are archived, never deleted.** A run points at the definition that
produced it, and that attribution is the only thing tying a year of history to
one migration. The name index is partial on `archived_at IS NULL`, so archiving
frees the name for reuse; the connection FKs are `restrict` so a delete can never
orphan one.

---

## Phase 4 — decisions

**Keyset, not `OFFSET`, and the tie-break is the whole point.** The run ledger is
a list with rows arriving at its head while it is being read — that is what a run
ledger *is*. Under `OFFSET 50`, a run launched between page one and page two
shifts every later row down by one, so the reader sees a run twice and never
sees another, on the one screen whose job is to be a complete record. The cursor
is `(created_at, id)` because two runs created in the same millisecond are not
hypothetical: launching a definition twice is one click apart, and `created_at`
alone would repeat or skip one at exactly the page boundary.

**A malformed cursor is a 400, never a silent page one.** A paging client handed
the first page when it asked for the third loops forever. `decodeCursor` returns
`undefined` for anything it did not write — never throws, never guesses — and
the route turns that into a refusal.

**The definition NAME is joined; the endpoints stay snapshotted.** Opposite
choices in the same row, deliberately. A definition is archived and never
deleted, so the join always finds it, and renaming a migration renames it across
its whole history at once — which is what renaming means. A database is a fact
about what ran, and must not change when the connection is re-pointed.

**Sparklines ride on the first page only.** They describe the definitions, not
the page; sending them again with page two would be a payload repeating itself,
which is a payload that will eventually disagree with itself. One windowed query
rather than one per definition, because the alternative is N+1 on a page that
already renders N rows — `runs_definition_idx` exists to serve exactly that
partition.

**A comparison is stored, not rendered and forgotten.** "The counts matched on
the 8th" is a claim someone will need to make later, and a screenful supports
nothing. The row is written *before* the counting starts, so a comparison that
fails halfway is a `failed` row naming the reason rather than no record at all —
and a comparison that produced no record is indistinguishable from one nobody
ran.

**Comparisons resolve through `resolveRunTarget`, with the launch gate turned
off.** "Compare what I just migrated" must name the two databases the migration
actually used, so it goes through the same resolver preview and launch use. But
the launch gate does not apply: a comparison runs no migration. Applying it
would have refused a query definition with a sentence about the timeline staying
blank — true of a run, irrelevant here. `checkMode: false`, and the caller
states its own reason: a query migration writes one table, so comparing every
table would report all the others as missing. **Both 422s were exercised live
and they say different, correct things.**

**Drift is `POST /runs/preview` read the other way round.** A preview answers
"what would a run change?"; after a migration that is exactly "what did the
migration not apply?". One endpoint and one `SchemaDiffView`, so the two screens
cannot develop two ideas of what a difference is. An all-zero diff renders as
*"The two schemas match"* — the answer, not an empty state, and precisely what
someone opening the compare page wants to be told.

**A percentile over nothing is null, never zero.** `durationP50Ms` is `null` for
an org with no settled runs and renders as an em dash. A dashboard that says
"p95: 0ms" tells a new organisation its migrations are instant.

**The comparison bar diverges from a centre line rather than filling from the
left.** The question is not "how far did it get" but "did it land on the
number", and a left-filled bar makes 99.9 % look like success at a glance —
exactly the case the table exists to catch. Over-100 % is drawn as an overshoot
rather than clipped, because a destination with more rows than its source is a
real outcome (a re-run that appended instead of replacing) and clipping it would
read as "matched".

**The mismatch filter defaults ON when anything mismatched.** Someone opening a
failed comparison wants the one row that is wrong, not to scroll past four
hundred that are right. Someone opening a clean one has nothing to filter and
sees everything.

**Sign-in lands on the org home, not `/connections`.** What someone opening Movy
wants to know is whether anything is running and whether the last thing that ran
worked — not which credentials are saved. No card grid: a 240px summary rail
beside the ledger, because the ledger *is* the page and the numbers are context
for it.

**`validation_table_counts` carries no `org_id`.** It keys on its parent alone,
exactly as `run_table_progress` does, and every read goes through
`requireValidation` — the org-scoped lookup and the only way in. The plan
sketched an `org_id` on it; a second copy of a scope is a second thing that can
disagree with the first.

---

## Bugs found in Phase 4

1. **drizzle-kit emitted migration `0003` in an order that cannot run.**
   `runs_org_id_uq` — the unique key `validation_runs_run_fk` references — was
   emitted *after* that foreign key. As generated, the migration fails on its
   third statement. Statement order is not something a schema snapshot can
   express, so `migration-sql.test.ts` now asserts it directly rather than
   relying on the snapshot.

2. **All four of `validation_runs`' composite foreign keys came back with a bare
   `ON DELETE set null`** — the same hand-edit `0001` and `0002` each needed,
   for the third time. It would try to null `org_id`, which is NOT NULL, so
   deleting any run, definition or connection a comparison referenced would fail
   outright. The guard in `migration-sql.test.ts` now covers `run_id` as well.
   **This one is now a pattern, not an accident**: any new composite FK with
   `SET NULL` will need the same edit, and the test is the only thing that
   catches it.

3. **`useFetch(url, { immediate: false, watch: [openId] })` silently never
   fired.** Opening a stored comparison by `?v=` left an empty pane where a
   result should be — no error, no console warning, nothing. Replaced with an
   explicit `watch` calling `useRequestFetch()`, which states plainly when it
   runs and forwards the session cookie during SSR. **No unit test could have
   caught this**; it needed a browser and a click.

4. **A ledger row grew taller whenever its database pair wrapped**, breaking the
   rhythm of the whole list — the same class of bug as the timeline colliding
   with itself on a wrapped label in Phase 3a. Rows are a fixed 40px now and
   every cell that can be long truncates.

5. Smaller: "1 do not match" for a single table.

---

## Phase 4 — verified live

Against the PostgreSQL on :5432, `movy_fixture_src` → `movy_fixture_dst`, in a
browser at 1440 and 375 and by curl:

- **Paging is exact.** Walked the whole 22-run ledger in eight pages of three:
  22 ids, 22 unique, identical to the single-request list and in the same order.
  Sparklines arrived on page one and on no other page.
- **Paging survives a row arriving at the head.** Inserted a run between reading
  page one and page two: it did not leak into page two, page two continued
  exactly where page one stopped, and the new run was at the head of a fresh
  read. Deleted afterwards.
- **The comparison detects both states, so a pass cannot be a no-op.** Deleted
  750 rows from the destination's `order_items`: 99.76 %, `allMatch: false`, one
  table mismatched, reported as 150,000 → 149,250 on exactly that table. Ran the
  real migration; compared again: 100 %, all five tables, `allMatch: true`.
- **Drift and counts disagree independently, which is the point of the pairing.**
  With rows missing but structure intact, the schema diff correctly said the two
  schemas match while the counts said they did not.
- **Percentiles came back as numbers**, not the strings that made every overall
  percentage 0 for PostgreSQL sources in Phase 1. `percentile_cont` returns
  double precision and node-pg hands that back as a string; it is parsed, not
  trusted.
- **Refusals**, each returning what it should: a viewer POSTing a comparison
  403, reading one 200; an editor 201; `stats/summary` 200 for a viewer; another
  org 404; a bad cursor 400; an unknown status 400; source and destination the
  same database 400; a query definition 422 with the comparison-specific reason,
  and the same definition launched 422 with the run-specific one; a validation
  id that does not exist 404.
- **A viewer's comparison payload carries no connection ids, no org id and no
  requester** — asserted in `validation-serializer.test.ts` and confirmed on the
  wire.
- In the browser as admin and as viewer, in dark theme, at 1440 and 375: the
  dashboard, the ledger with its filters, the compare page and a stored result
  all render with **no console errors and no hydration warnings** — including
  the ledger, whose `toLocaleString()` mismatch is now fixed.

The five comparisons and the one extra run left behind are ordinary history of
the kind the ledger already held, and the fixture databases are back in a
matching state.

## Bugs found in Phase 3b

1. **`ON DELETE RESTRICT` raises `23001`, not `23503`.** `isForeignKeyViolation`
   matched only `foreign_key_violation`, but PostgreSQL raises
   `restrict_violation` for a RESTRICT constraint — so "2 saved migrations still
   use this connection" arrived as a 500 quoting the constraint name. **The unit
   test asserted the code I had assumed and passed the whole time**; only the
   live database found it. Both codes are matched now.

2. **Enum degradation cannot be read off the translator's output.**
   `CrossDbSchemaTranslator` passes an unmapped type through *unchanged*, so a
   PostgreSQL enum type crossing to MySQL comes back identical to what went in —
   and "unchanged, therefore fine" gets that case exactly backwards. The warning
   is decided by comparing the two ENGINES instead.

3. **`runs_definition_fk` needed the same hand-edit as migration `0001`.**
   drizzle-kit emits a bare `ON DELETE set null` for a composite key, which would
   try to null `org_id` too — and `org_id` is NOT NULL, so deleting any
   definition a run referenced would have failed outright. `migration-sql.test.ts`
   now guards `definition_id` alongside the two connection columns.

4. **`pnpm seed:dev` had never loaded `apps/web/.env`.** Pre-existing, and a
   documented command in `CLAUDE.md`: it read `process.env.NUXT_DATABASE_URL`
   and nothing put it there, so it only worked for someone who had already
   exported it. Now `tsx --env-file=.env`.

---

## Decisions that are load-bearing

**Events describe progress, never configuration.** `SafeEndpoint` carries engine
and database only. An earlier draft had `host` on `run_started`, which a viewer
subscribed to the run would have received. Keeping configuration off the event
stream is what makes it uniformly safe to broadcast — do not add a field to an
event "just for the timeline".

**`seq` is assigned by the producing process, not the consumer.** If Nitro owned
the counter, a server restart would reset it and destroy the replay cursor.
`SeqSink` also sits *outside* `ThrottledSink`, so coalesced events never consume
a `seq` — otherwise a reconnecting client sees gaps and thinks it missed data.

**Role is never in the session cookie.** A sealed cookie is stale by
construction; a demotion must take effect on the next request. It is read per
request from `memberships`.

**404, never 403, for a non-member org.** A 403 confirms the org exists, turning
the slug space into an enumeration oracle.

**The repository layer is the wall.** `org_id` is bound in the constructor, never
a parameter, so `findById(id)` cannot be written unscoped. Middleware and role
checks are policy; this is the thing that makes the bug unwritable.
`route-scoping.test.ts` fails CI if a route is not org-scoped, is not gated on a
permission, or imports the Drizzle client directly.

**`run_events` is keyed on `(run_id, seq)`, not a surrogate id.** Delivery is
at-least-once from two independent sources — IPC and the journal tailer — and
this key is the whole reason that is safe. Do not add an id column.

**The runner must outlive its host, and that is not free.** `process.send`
exists after the host dies; only `process.connected` tells the truth. Every
IPC call in the runner is guarded on it. Removing those guards silently reverts
the journal from a system of record to a log of whatever the host was awake for.

**Nothing the client sends may reach a room name.** `roomKey()` takes a
`SubscriptionGrant`, and only ticket redemption produces one. The socket
performs no authorisation of its own; it redeems a decision made by an ordinary
HTTP request. Adding a string-keyed join would undo the entire guarantee, and
`socket-isolation.test.ts` asserts the source shape for that reason.

**Broadcast only after the durable write.** A client loads its snapshot from the
database and then goes live. If an event were announced before it were
queryable, everything between those two moments would be invisible to that
client — and a gap it was never told about is one it cannot recover from.

**One declaration of the wire, in `shared/`.** Both halves of a contract
described twice will disagree eventually — and when they did here, every unit
test still passed, because each side was tested against its own copy. If you add
a frame or a field, add it there and let the compiler find the callers.

**Serializers build up, never tear down.** There is no `delete row.secret`
anywhere — a field that is never copied cannot be forgotten.

**`@movy/core` stays CommonJS**, because `resolveWorkerPath()` depends on
`__dirname` and runs load core from disk. Its relative import specifiers carry
explicit `.js` extensions so the output is valid under both CJS and ESM
resolution. `module-specifiers.test.ts` enforces this.

---

## Bugs found and fixed along the way

Three of these were pre-existing and only surfaced by running against a real
database. Mocks could not have caught any of them.

1. **`resolveWorkerPath()` was broken in production.** `rootDir: "./"` made `tsc`
   emit `dist/src/**`, so `dist/infrastructure/migration/` — the directory the
   code looked in — was never produced. Under `NODE_ENV=production` it returned
   that path unconditionally, without checking existence. It only appeared to
   work because a stale flat `dist/` from an older config sat in the tree.

2. **Row estimates were strings, so every overall percentage was 0.**
   node-pg returns `reltuples::bigint` as a string; `query<T>` is an unchecked
   cast, so `Map<string, number>` held strings and `0 + "20000"` concatenated.
   The CLI had been printing `(overall: 0.0%)` for PostgreSQL sources all along.

3. **Re-running into a populated PostgreSQL destination failed for every FK
   parent.** `TRUNCATE x RESTRICT` per table, inside parallel workers. PostgreSQL
   refuses to clear a table another references, and `DISABLE TRIGGER` does not
   lift it — it is a structural check. Now cleared as one grouped statement,
   before any worker starts. Grouped rather than `CASCADE` on purpose: `CASCADE`
   would silently empty tables outside the migration set.

4. **Nuxt dev returned 500 on every route** — see the CommonJS note above.

5. **`pnpm start` had been broken since `e8c33ea`.** That commit gave core's
   relative specifiers explicit `.js` extensions — correct for the emitted
   output, but ts-node's CommonJS resolver takes `./x.js` literally and cannot
   fall back to `./x.ts`. So the CLI's own documented dev command failed on this
   branch. Fixed by moving `start` / `dev` / `simulate` to **tsx**, which does
   that remapping; `ts-node`, `ts-node-dev` and `tsconfig-paths` are gone.

---

## Environment

- **pnpm 10.33** (`packageManager` pinned). npm 10.9.7 crashes on Nuxt's peer
  graph (`#loadPeerSet`, `edgesOut` of null) — an npm bug, not our config.
- **Metadata database: `movy_data`** on the local Docker PostgreSQL (`:5432`),
  ten tables. Distinct from any database being migrated. **PostgreSQL 15+**, for
  the column-scoped `ON DELETE SET NULL` in migration `0001`.
- **Run journals** land in `apps/web/.movy/runs/<runId>.ndjson` (override with
  `MOVY_JOURNAL_DIR`), each with a `.stderr.log` beside it. Gitignored.
- **The runner binary** is found via `@movy/runner`'s built `dist/main.js`, else
  the TypeScript entry loaded through tsx, else `MOVY_RUNNER_ENTRY`. A stale
  `dist/` therefore wins over edited sources — `pnpm build` after touching the
  runner, or the fix you just made will not be the code that runs.
- **`apps/web/.env`** is gitignored and holds a generated `NUXT_ENCRYPTION_KEY`
  and `NUXT_SESSION_PASSWORD`. Rotating either is destructive: the first orphans
  every saved connection secret, the second signs everyone out.
- **Fixture databases** on the same server, both throwaway:
  `movy_fixture_src` (5 tables, 315k rows, FK chain — worth keeping for real
  runs) and `movy_fixture_dst` (rebuilt on every run).
- Google SSO is wired but needs `NUXT_OAUTH_GOOGLE_CLIENT_ID`/`SECRET`.

```bash
pnpm install
pnpm dev:web        # http://localhost:3000
pnpm test
pnpm build
pnpm seed:dev       # admin@ / editor@ / viewer@movy.local, password movy-dev
```

Sign in as the viewer to watch the write paths disappear.

---

## Phase 2 — onboarding (done)

Closed on 2026-09-08. Two unscoped routes, five org-scoped ones, three pages
and an org switcher — the half of Phase 2 that the connections work had
skipped over.

| Surface | Purpose |
|---------|---------|
| `POST /api/orgs` | Create an org; the caller becomes its admin, in one transaction |
| `GET …/members` | Members always; outstanding invitations only for an admin |
| `PATCH …/members/:userId` | Change a role |
| `DELETE …/members/:userId` | Remove a member (or leave) |
| `POST …/invitations` | Mint an invitation; the link is in this response and nowhere else |
| `DELETE …/invitations/:id` | Revoke |
| `POST /api/invitations/preview` | What a link leads to, before committing |
| `POST /api/invitations/accept` | Redeem it |

Pages: `/orgs/new`, `/o/:slug/members`, `/invite/:token`; plus the org switcher
in the header, a `People` rail entry gated on `member:read`, and a `/no-access`
page that now offers a way out instead of only explaining the dead end.

### Decisions that are load-bearing

**Three routes cannot be org-scoped, and that is stated in the test rather
than in a comment.** Creating an org and redeeming an invitation are the acts
that *produce* a scope, so `orgs.repo.ts` takes a user and no org id. It is
therefore the one module that could reintroduce the cross-tenant hole the
repository wall closes — so `route-scoping.test.ts` fails if anything under
`orgs/[orgSlug]/` imports it, exactly as it already does for the unscoped run
ingestion helpers.

**An org can never be left without an administrator.** `wouldOrphanOrg()` is a
pure predicate consulted by both the demote and the remove path; an org with no
admin cannot be repaired from inside the product, because nobody left can
invite or promote. The UI disables the control *and* names the reason, and the
server refuses independently.

**An invitation admits one address, once.** The row stores only a sha256 of a
256-bit token; acceptance is inside a transaction that takes `FOR UPDATE` on
the invitation, so two people redeeming the same link cannot both pass the
status check. The address is compared case-insensitively, so a link that
escapes into a group chat still admits only its recipient.

**An invitation never changes an existing member's role.** Acceptance is
`ON CONFLICT DO NOTHING`. Otherwise an invite issued for a viewer would be a
way to strip an admin of their own org — a demotion instrument wearing a
welcome message.

**The preview does not return the invited address.** It answers *which org,
which role, does it match you* — because whoever ends up holding a leaked link
would otherwise learn a colleague's email from it.

**Re-inviting replaces the outstanding invitation** rather than adding a second
one. `(org_id, email)` is unique, and every extra live token is another way in.

**Revoking is a state change, not a delete.** Who invited whom, and that it was
withdrawn, is the sort of thing an org needs to be able to look up.

**`shared/org-slug.ts`, not two slug rules.** The client previews the slug while
you type and the server validates it; one declaration, the same reasoning as
`run-wire.ts`. It folds diacritics rather than dropping them — `Ácme` becomes
`acme`, not `cme`, which would be a different organisation wearing a similar
name — and refuses the words the app already owns (`new`, `api`, `o`, …).

**`?next=` survives the sign-in bounce, through `safeNext()`.** An invitation
link opened while signed out has to come back after login, and an unchecked
`next` is an open redirect handing someone who just typed their password to a
lookalike site. Only a path on this origin survives, and `//host` does not.

### The bugs this step found

1. **A duplicate slug returned 500 with the failing SQL in the body.** Drizzle
   wraps the driver error in its own `DrizzleQueryError`, so the pg code sits on
   `cause`; reading `err.code` alone matched nothing. `isUniqueViolation()` now
   walks the chain (bounded, so a self-referencing `cause` cannot loop), and
   `unique-violation.test.ts` pins both shapes.

2. **Every valid invitation rendered as "That invitation link is not valid".**
   The preview ran through a plain `$fetch` during SSR, which does not forward
   the incoming request's cookies, so it 401'd on the server and the page only
   ever saw the failure — the exact trap `auth.global.ts` documents two files
   away. `useRequestFetch()` fixes it. **Neither this nor the one above could
   fail a unit test**; both needed a browser and a real database.

3. **A hydration mismatch on every date.** `toLocaleDateString()` resolves
   against Node's locale on the server and the browser's on the client:
   `2026-09-07` against `9/7/2026`. Pinned to `en-CA` on the members page.
   *`app/pages/o/[orgSlug]/runs/index.vue` still has this*, via `toLocaleString`
   — same fix, not made here because it is outside this step.

### Verified against the live server

Sign in, create an org, and it appears in `/api/me` as admin. Reserved slug
`new` → 400; duplicate `acme` → 409; role `owner` → 400; inviting an existing
member → 409. An editor listing members sees the three people and no
invitations, and gets 403 on invite; a viewer gets 403 on the member list
entirely, and 404 — never 403 — for an org they do not belong to. An
invitation previewed by the wrong person does not disclose the invited address
and cannot be redeemed; the intended recipient joins, and the same token then
returns 410. Demoting or removing the last admin returns 409 both times, and
succeeds once a second admin exists. A revoked token returns 410, and a
member id from another org returns 404.

In a browser at 1440 and 375, in dark theme, as admin and as editor: the invite
panel shows the link once with the warning that it is shown once, the role
selects and the Leave button are disabled on the last admin with the reason in
their `title`, and the editor sees a read-only list with no invitations
section. No console errors and no hydration warnings.

The verification data (an `initech-data` org and two invitations) was deleted
afterwards; the dev database is back to `acme` + `globex` as `pnpm seed:dev`
leaves it.

---

## Phase 3a step 1 — the runner (done)

`apps/runner` is now the real thing. Full contract in `apps/runner/README.md`.

- `--simulate <fixture> --speed <n>` replays a recording at the recorded pace
  (`0.05` = 20x slower, for watching a demo). `runId` and `at` are rewritten,
  `seq` is preserved, and both modes funnel through one `publish()` — so nothing
  downstream can tell a simulated run from a real one.
- **The run spec arrives on stdin, not argv.** `ps` is world-readable and the
  spec carries two passwords. `RunSpecError` names the field, never the value.
- **The journal is written before IPC**, always. The runner forks `detached`, so
  it outlives a host restart; the host re-attaches from the file.
- Exit codes 0/1/2 = succeeded/failed/cancelled; 64/70 = never started.
- SIGTERM, SIGINT and IPC `{k:'cancel'}` all abort the same controller.
- `tests/process/` forks the real binary detached with IPC and asserts the whole
  contract. No database needed.

Two things surfaced while building it:

- **`pnpm start` was broken on this branch.** `e8c33ea` gave core's relative
  specifiers explicit `.js` extensions, which ts-node's CommonJS resolver cannot
  map back to `.ts`. The CLI's documented dev command had been failing since.
  Switched `start` / `dev` / `simulate` to **tsx**, which does that remapping;
  dropped the now-unused `ts-node`, `ts-node-dev` and `tsconfig-paths`.
- **The fixture has 118 events, not 117**, and its terminal `run_finished` is at
  `seq` 117 — *not* the last line. `ThrottledSink` flushes its held progress
  sample on close, so a trailing `overall_progress` follows the terminal event.
  **Every consumer must take the outcome from the event, never from the last
  line.** `fixture-replay.test.ts` pins this.

## Phase 3a step 2 — the RunManager (done)

Four new tables (`runs`, `run_events`, `run_steps`, `run_table_progress`), five
routes under `/api/orgs/:slug/runs`, and the ingestion pipeline behind them.

- **`run-projection.ts` is pure and outside the database**, the same reason
  `run-reducer.ts` will sit outside the client store. Every rule worth getting
  right — a terminal status comes from the event and not from arrival order, a
  cursor only climbs, a finished table does not un-finish — is tested against
  the recorded fixture with no Postgres in the room.
- **`run_events` is keyed on `(run_id, seq)`.** Events arrive from IPC *and*
  from the journal tailer, and that key is what makes the second delivery an
  `ON CONFLICT DO NOTHING` no-op rather than a duplicate the timeline has to
  reason about. Everything else about re-attach follows from it.
- **`EventWriter` batches** (200 events or 250ms). Safe only because the journal
  is the record: anything lost between flushes is re-read on the next boot. A
  failed metadata write is swallowed, never rethrown into the IPC handler — it
  must not take down the process supervising a live migration.
- **`reattach()` is not a one-shot.** IPC dies with the old host and can never
  be re-established, so a run still in flight is *followed* — its journal
  re-read every second until a terminal event or the process is gone. A single
  catch-up read would have left a live orphan invisible until the next boot.
- **Runner stderr goes to `<journal>.stderr.log`**, not `inherit`. A detached
  child holding the host's stderr descriptor is tied to the host after all. This
  paid for itself within the hour — see the bug below.
- Cancellation is cooperative and says so: `cancelling` is a real status,
  because the orchestrator only observes the abort at a step boundary.

Verified end to end against the live database and the recorded fixture: launch,
watch, cancel (`cancelling` → `cancelled`), 409 on a second concurrent run,
403 for a viewer on execute/cancel, 404 for a non-member org, and a viewer's
event stream carrying all 43 timeline events and none of the 75 log lines.

### The bug this step found

**The runner did not actually survive its host.** `process.send` still *exists*
after the host dies — only `process.connected` goes false — so
`process.send?.(...)` sailed straight past the optional-call guard, Node emitted
an unhandled `'error'` on `process`, and the runner died a few events into being
orphaned. `process.disconnect?.()` had the same flaw at exit, and because it
threw into the `.catch`, a run that had completed reported exit code 70: *the
run never started*.

Everything about the journal being the system of record was written against a
premise that was false in practice. It only surfaced by actually killing the dev
server mid-run — no unit test would have found it, because the failure needs a
real parent process to really die. `apps/runner/tests/process/host-death.test.ts`
now pins it: fork detached, kill the host mid-replay, assert the orphan writes
its remaining journal and records its own terminal event.

## Phase 3a step 3 — the live stream (done)

**Not Socket.IO.** Nitro's own WebSocket support (crossws) is already a
dependency and works in dev; Socket.IO would have meant a new runtime dep plus
attaching to the raw HTTP server behind Nuxt's dev proxy — exactly the
integration risk the half-day timebox was hedging. The sidecar fallback was not
needed. `nitro.experimental.websocket` is on, and the handler is
`server/routes/_ws/runs.ts`.

**Subscriptions are authorised over HTTP, never on the socket.** A client POSTs
`/api/orgs/:slug/runs/:id/ticket` — an ordinary request that has already been
through `01.auth`, `02.org` (membership and role, read fresh), a
`requirePermission` gate and an org-scoped lookup — and gets a single-use,
30-second ticket. The socket redeems it and decides nothing.

The alternative was unsealing the session cookie at the upgrade. The cookie *is*
readable there, but `getUserSession()` needs a real `H3Event` and there is none,
so it would have meant reimplementing nuxt-auth-utils' unsealing inside the
socket layer and then re-resolving org and role a second way. Two
implementations of "who is this and what may they see" is how the second one
ends up wrong.

The ticket also buys the property that matters most here: **`roomKey()` is
reachable only with a `SubscriptionGrant`**, and only ticket redemption produces
one. There is no path from anything on the wire to a room name — which is the
leak `socket-isolation.test.ts` was written to catch, and it asserts the shape
of the source, not just the behaviour.

- **Broadcast happens after the durable write**, never before — `EventWriter`'s
  `onFlushed`. Announcing first would leave every event between a client's
  snapshot read and the next flush invisible to it, and a client cannot detect
  a hole it was never told about.
- **A peer joins its room before its snapshot is read**, so an event landing
  during the read is duplicated rather than dropped. The client de-dupes by
  `seq`; a gap it could not.
- **Cohorts are rooms, not a per-message filter.** The redacted room gets
  everything except `log`, so a new event type added to the core reaches
  viewers instead of silently vanishing from their timeline.
- **A demotion reaches a live socket.** The hub re-reads every subscriber's role
  every 5s and moves or evicts them. The check is one batched query for all
  subscribers, deduplicated per person — which is what makes an interval that
  short affordable. Measured live: `cohort_changed` at 5.0s, two further log
  lines in the window, zero after.

Verified against the live server: an editor and a viewer watching the same run
received 118 and 43 events respectively — all 75 log lines to the editor, none
to the viewer, both gapless. Forged, spent, absent and malformed tickets are all
refused with one indistinguishable message, so the socket is not an oracle for
which runs exist. A valid viewer ticket sent with `cohort: 'full'`, `orgId`,
`runId` and `room` fields attached ignored every one of them.

### The bug this step found

**`EventWriter.flush()` did not wait for a write that was already in flight.**
It looked only at the buffer, so it resolved immediately whenever a batch was
mid-write. `RunManager` awaits that flush before settling a run, meaning a run
could be marked finished before its last events were stored — and the socket
work made it visible, because "durably stored" became something another
component depended on rather than an internal detail.

## Phase 3a step 4 — the UI (done)

Two pages under `/o/:slug/runs`, four components, and one pure reducer.

**`shared/run-wire.ts` is the contract.** Nuxt 4's `shared/` directory, so the
serializer and the reducer import the same declarations — a field the server
stops sending is a type error in the client rather than `undefined` in front of
someone watching a migration. It restates the nine step ids rather than
importing them from `@movy/core`, because core is CommonJS and the client bundle
cannot import it (the server bundle inlines it — see CLAUDE.md); `step-order.test.ts` fails if the copy ever drifts.

**`app/utils/run-reducer.ts` is pure and outside any store**, the same reasoning
as `run-projection.ts` on the server. It de-duplicates by `seq` (the snapshot
and the first live batch overlap by design), takes the outcome from
`run_finished` rather than the last frame, and does not un-finish a table when
the throttle's held sample arrives late. All of that is tested against the
recorded fixture with no component, no socket and no browser involved.

**`useRunStream` degrades to REST.** The socket is a fast path over a durable
record, so every failure falls back to `GET .../events?afterSeq=` — the same
cursor the socket would have used — with capped exponential backoff. It also
pages that endpoint after every snapshot, because the snapshot caps at 500
events and a run further along than that still has a gap to close.

The frame contract, as built:

| Frame | Meaning |
|-------|---------|
| `{k:'hello'}` | connected, nothing authorised yet |
| `{k:'subscribe', ticket}` | client -> server, the only message accepted |
| `{k:'snapshot', run, steps, tables, events, lastSeq, cohort}` | opening state |
| `{k:'events', runId, events[]}` | live batch, ordered, may repeat a seq |
| `{k:'cohort_changed', cohort}` | role changed under you |
| `{k:'revoked', reason}` | membership gone; socket closes |
| `{k:'error', message}` | refused; socket closes |

Verified in a browser at 1440, 768 and 375, in both themes, as editor and as
viewer: the timeline draws, the grid fills, the log follows its own tail, and a
viewer sees the whole timeline with the log pane replaced by the reason it is
empty.

### The bugs this step found

1. **The live stream and the snapshot spoke different shapes.** The hub
   published bare `MigrationEvent`s while the snapshot sent `WireEvent` rows, so
   every live frame threw in the reducer — `payload` was undefined. It survived
   step 3 because my probes only read `type` and `seq`, which both shapes have,
   and it survived unit tests because `socket-isolation.test.ts` built one shape
   while `run-reducer.test.ts` built the other. **Each half was tested against
   its own idea of the wire.** Both now use `WireEvent`, and a test feeds the
   hub's real output through the real reducer.

2. **`simulateFixture` was a filesystem path off the request body**, handed to
   the runner as `--simulate <path>`. Any editor could name any file on the
   host. The API now takes `simulate: true` and the server owns the path;
   `route-scoping.test.ts` fails if a route takes a path from a body again.

3. Smaller: the timeline collided with itself whenever a label wrapped; log
   timestamps were UTC while everything else was local; `ELAPSED` showed the
   *recording's* 407ms rather than this run's wall clock; the 200px rail made
   the page scroll sideways on a phone; and a viewer's log pane said "no log
   output yet" for a run with 75 log lines, because the cohort was only sent on
   a *change* and a viewer is never demoted mid-session. It is on the snapshot
   now.

Demo for 3a: click Run, watch a simulated migration draw itself, kill the dev
server mid-run, restart, and watch the UI re-attach and catch up. **The server
half of that demo already works** — drive it with:

```bash
curl -b cookies -X POST localhost:3000/api/orgs/acme/runs \
  -H 'content-type: application/json' \
  -d '{"sourceConnectionId":"…","targetConnectionId":"…",
       "simulateFixture":"'"$PWD"'/apps/runner/fixtures/pg-to-pg-315k.ndjson",
       "speed":0.008}'
```

**Write `socket-isolation.test.ts` at the same time as the socket code.** A room
name concatenated from client input is the single easiest cross-org leak in this
design, and nothing else catches it.

---

## Known gaps, deliberately left

- **`rowsCopied` over-reports by ~0.09%.** `table-copy.worker.ts` counts
  newline-split segments per COPY chunk, so a row straddling a boundary is
  double-counted. Data is exact — `ValidateCountsUseCase` confirms 315,000 =
  315,000 — only the reported number drifts. It will show as slightly wrong row
  counts in the UI.
- **Clearing strategy still differs per migrator**: MSSQL→PG uses `CASCADE`,
  MySQL and MSSQL destinations use a row-removal fallback. Not broken, but three
  answers to one question.
- **Query mode is PG→PG only** and emits no progress; the UI must disable it for
  other Pairs *with the reason shown*, not fail at run time.
- **No schema support.** `ConnectionConfig.schema` is stored and displayed but
  not honoured; Movy migrates the default schema only.
- **No resume.** A failed run leaves partial state. Do not offer a Retry button
  that silently re-copies everything. A run whose process vanished is settled as
  `failed` with `RunnerVanished`, and its message says the migration may be
  partially applied — say that in the UI too.
- **`maxConcurrentRuns` is per org and defaults to 1.** A second launch gets a
  409. That is also what stops two runs clearing each other's destination.
- **Composite foreign keys with `SET NULL` need a hand-edit every single time.**
  Three migrations, three edits; `0003` needed four in one file, plus a
  statement reorder. drizzle-kit cannot emit the column-scoped form, so assume
  the next one is wrong too and read the generated SQL before applying it.
  `migration-sql.test.ts` is the only thing that catches a regression.
- **Composite FKs on `runs` need PostgreSQL 15+.** `0001` uses the
  column-scoped `ON DELETE SET NULL (<column>)`, hand-edited because drizzle-kit
  emits a bare `SET NULL` that would try to null `org_id`. `migration-sql.test.ts`
  fails if a regenerated migration drops it.
- Docs are current as of Phase 5: `CONTEXT.md` gained Organization, Definition,
  Run, Timeline, Comparison and Drift; `README.md` describes the workspace and
  the web console; ADR 0002 (run execution) and ADR 0003 (org tenancy) exist.


---

## Phase 5 — decisions

**Redaction is the net, not the design.** The design is that events carry
progress and never configuration — `SafeEndpoint` has engine and database and
nothing else, precisely so there is no field for a password to sit in. But two
strings on every event are written by code that has never heard of that rule:
`log.message` and a `SerialisedError`'s `message`. A driver quoting its DSN back
on a failed handshake lands a password on a stream read-only viewers subscribe
to. `RedactingSink` goes inside `SafeSink` and outside the throttle, at the one
seam that feeds the journal, IPC and the socket alike, so no consumer has to
remember to scrub for itself.

**Secrets under four characters are deliberately not redacted.** A
two-character password appears inside ordinary words — "at", "in", a table
called "orders" — and redacting it would shred every message on the stream while
advertising, by the placement of the marks, exactly what the password was. A net
that destroys the timeline is worse than the hole it leaves, and the hole is
bounded because the primary defence is still that no event has a field for a
credential.

**The redaction test asserts output, not implementation.** It drives a real
orchestrator whose driver throws the DSN back at it and then searches every
emitted byte, so it does not know which field the password would have travelled
in. Verified by disabling redaction: four of the ten assertions fail, including
the run-level one. A test that passes either way proves nothing, and this was
checked rather than assumed.

**Cancellation checks the signal before the TRUNCATE, not only before the
copy.** Emptying the destination is the single most destructive thing a run
does, and a cancellation arriving while the schema step was still finishing must
not be answered by wiping five tables and then stopping.

**`WorkerPool` resolves rather than rejects when it was terminated.** A killed
worker exits non-zero, indistinguishable by code alone from a crash — so without
the flag, cancelling a PG→PG run surfaces "Worker exited with code 1" as the
reason it failed, when the reason is that someone pressed Cancel.
`PgDataMigrator` then re-checks the signal itself, because a pool that resolves
would otherwise return a partial result that reads as success.

**The taxonomy answers `unknown` rather than guessing.** A wrong classification
is worse than none: telling someone their password is wrong when the host is
unreachable sends them to rotate a working credential. Matched on driver codes
first and prose only as a fallback — codes are stable, and a PostgreSQL server
with `lc_messages = fr_FR` says "l'authentification par mot de passe a échoué",
which no English substring will ever match, while `28P01` is the same
everywhere. The driver's own words are kept, redacted, beside the summary.

**Only `log` events are capped.** It is the one unbounded type: the throttle
coalesces progress to four a second per key and the plan bounds the structural
events, but `SinkLogger` puts every `logger.*` call on the stream and
`MigrateDataUseCase` logs once per 500-row batch, so a 50-million-row migration
writes ~100k log rows for one run. Dropping a `step_finished` or a
`run_finished` would leave a run permanently unsettled with a half-drawn
timeline — far worse than a large table.

**At the cap the event is replaced, not skipped.** The notice carries the same
`seq`. The client de-dupes by seq and requires only monotonicity, so a hole
would have been legal — but a log pane that simply stops has no way to say why,
and a person watching would read it as a hang.

**A stalled run is reported, never settled.** Marking a live-but-silent run
failed frees its org's concurrency slot and lets a second run launch into a
destination the first is still writing to, which turns a stall into corruption.
And silence is not proof of a stall: `CREATE INDEX` over tens of millions of
rows emits nothing for as long as it takes, which is what set the 30-minute
threshold. A watchdog nobody believes is worse than none.

**Retention prunes `run_events` and nothing else.** `runs`, `run_steps` and
`run_table_progress` are the ledger — small, bounded by the number of runs
rather than the size of the data — and deleting them would make a year of
history vanish rather than merely lose its narration. A run still in flight is
never touched however old its first events are: pruning underneath a live reader
would make the timeline it is watching go backwards.

**The E2E run is simulated.** The bundled fixture replayed through the real
runner, socket, writer and reducer, so all the machinery is exercised without
depending on two throwaway databases existing on whoever's machine runs it. The
mid-run reload is the point: every other step is covered by unit tests against
mocks, and none of them can cover a real browser losing its WebSocket,
re-fetching a snapshot and continuing from the same `seq`.

## Phase 5 — what the work found

**Nuxt hydration silently swallows form input.** Server-rendered inputs exist
and accept text a beat before Vue has bound `v-model` to them. Playwright's
`fill` and `click` both "succeed", the model stays empty, the submit posts
nothing, and the test dies 90 seconds later with no error anywhere on screen.
`waitForLoadState('networkidle')` before touching the form is the fix. Worth
knowing beyond the tests: a real user on a slow connection can do the same
thing.

**Playwright's top-level `request` fixture carries no session cookie.** It 401s
in a way that reads exactly like a permission bug in the handler. `page.request`
shares the browser context.

**A ledger row shows no run id.** It shows the definition's name and the two
databases; the id is only in the `href` of the link it wraps. Asserting on
`runId.slice(0, 8)` was wrong about the UI, not about the data.

**The coverage columns are statements / branches / functions / lines**, which is
not the order the `thresholds` object lists them in. Setting them by position
made the gate fail against numbers that had actually improved.

**`CLAUDE.md` was already current on Phase 4.** The *Remaining work* list said
otherwise. Struck after checking — a handoff file that is wrong about itself is
the specific failure this document's working agreement exists to prevent.

## Phase 5 — verified

- `pnpm test` — 1188 unit tests across 86 files, green, no database.
- `pnpm typecheck` — clean across all four workspaces.
- `pnpm test:coverage` — 63.28 / 48.02 / 66.99 / 64.06, thresholds re-ratcheted
  and passing.
- `pnpm test:e2e` — 8 Playwright specs against the real app on :3000 with the
  dev seed, including a simulated run reloaded mid-flight and caught up, a
  finished run replayed cold from stored events alone, a viewer shown no log
  lines, and the skip link reached by the first Tab.
- Redaction proved by removal: disabling `RedactingSink` fails 4 of the 10
  assertions in `credential-redaction.test.ts`.

---

## Bugs found reviewing Phase 5

**Reviewed 2026-09-09, immediately after `1329ca1` was committed. Five defects,
four of them in the hardening that commit added. All fixed in `6f13fcd`.**

The review is recorded because Phase 5's own tests passed throughout: the first
two below were invisible to a suite whose every cancellation case used a
two-table plan.

**A cancellation did not escape `migrate()` when the cancelled table was last in
`loadOrder`.** All four sequential migrators wrapped a table's copy in a
try/catch that turns a failure into a `TableMigrationResult` — correct for a
driver error, wrong for a cancellation. Reproduced against the real migrator in
two shapes before fixing:

| Abort lands during | `migrate()` returned | Threw |
|---|---|---|
| a full 500-row batch | `success: false`, table **`failed`**, error `Migration cancelled mid-copy of "parent"` | nothing |
| the final short batch | **`success: true`** | nothing |

The second is the serious one: a cancelled, partly-written destination reporting
a clean success. The first is the visible one: `run_table_progress` showing a
table failed while the run showed cancelled — two surfaces disagreeing about the
same event, which is exactly what "every surface reporting one must say so" is
meant to prevent.

Both were survivable **only** because `MigrationOrchestrator.step` gates steps
7–9 and throws there. That is a downstream accident, not the migrator's own
contract. Call `MigrateDataUseCase` with nothing after it, or reorder the steps,
and the accident stops saving it. `rethrowIfCancelled` now heads every per-table
catch and a `throwIfCancelled` closes each iteration — the second is what
catches the short-batch case, because the copy loop breaks on
`rows.length < BATCH_SIZE` without ever re-reading the signal. The rethrow is
deliberately narrow, and a test asserts an ordinary driver error is still
reported as a table outcome rather than thrown.

**MySQL and MSSQL cleared the destination without checking the signal first.**
Found while fixing the above. `PgDataMigrator` guarded its TRUNCATE in Phase 5
on the reasoning that emptying the destination is the most destructive thing a
run does; the other two would empty every table on an already-cancelled run and
only then stop. Same guard, same reason.

**The stall watchdog only ever watched re-attached runs.** `follow()` is called
from `reattach()` and nowhere else, so the ordinary case — a run this host
forked itself — had no stall detection at all. That is backwards: a runner
wedged on a lock it will never get keeps its IPC channel open, writes nothing
and never exits, so neither the exit handler nor the journal tailer has anything
to react to. A single unref'd sweep now scans live handles against the same
30-minute window and reports through the same `onStalled`, which needed no
rewiring. It still reports and never settles.

**Retention read `retention_days` with no floor.** Nothing writes that column,
so it is always the default 30 and the bug is latent — but the day it becomes an
org setting, `make_interval(days => 0)` deletes every finished run's events on
the next sweep. `AND o.retention_days > 0` fixes the reading: a zero window
means keep everything, never delete everything.

**Two redaction paths were open, both latent.** The runner's `fatal` frame never
went through `composeSink`, and the host persists it to `runs.error_message` and
serves it to viewers — `executeRun` catches every migration error into a status,
so nothing credential-bearing reaches it today, but that is a property of a
function two files away rather than a guarantee the seam makes for itself. And
`redactValue` failed **open** past its depth cap, forwarding a subtree it had
not searched. The first attempt at that fix replaced only deep *strings* and
still leaked, because at the cap the value is the containing object, not the
string inside it; it now replaces any string or container it cannot walk and
passes scalars through. A net that fails open at a known depth is worth less
than the depth cap saves.

## Phase 5 review — verified

- `pnpm test` — 1199 unit tests across 86 files, green, no database (was 1188).
- `pnpm typecheck` — exit 0 across all four workspaces.
- `pnpm build` — exit 0.
- `pnpm exec vitest run apps/runner/tests` — 62 green, including the process
  tests that fork the rebuilt binary, which is what exercises the `fatal` change.
- `pnpm test:coverage` — 63.35 / 48.35 / 67.04 / 64.09, up on every axis;
  `functions` re-ratcheted 66 → 67.
- Proved by removal, not merely by passing: reverting
  `mysql-data-migrator.adapter.ts` to `1329ca1` fails exactly 3 of the new
  tests. A test that passes either way proves nothing, so this was checked
  rather than assumed — the same standard Phase 5 set for `RedactingSink`.

**Not filed as issues.** All five were fixed in the same session as they were
found, so a tracker entry would have been opened and closed unread. The three
open issues (#3, #4, #5) remain CLI-side and untouched.


---

## Connections — edit, delete, and the reason a test failed (2026-09-09)

Not a phase. Three gaps in the one screen an operator uses before anything else
works, all of them the same shape: the API could already do it and the UI could
not reach it.

**The PATCH and DELETE handlers existed from Phase 2 and had no caller.** A
connection could be created and tested and never corrected — a typo in a host
meant deleting the row and retyping the password, and there was no way to delete
it either. Both handlers were already written, already permission-gated, already
returning the right 404s. The work was a form and a confirmation, not an
endpoint.

**One drawer per row, holding `{ id, kind }` rather than four booleans.** Four
things want to open under a connection — its databases, its edit form, its
delete confirmation, and why its last test failed — and they are mutually
exclusive by nature: nobody edits a connection and confirms deleting it at once.
A single nullable pair makes that structurally true instead of true until
somebody adds a fifth.

**A failed test opens its own reason.** The outcome of pressing Test is a
sentence, not a red dot; `describeConnectionFailure` has been writing that
sentence since Phase 2 and it lived in a `title` tooltip. It now expands under
the row the moment the result arrives, and the `failed` badge is a button that
toggles it back — the reason must stay reachable after the auto-expand is
dismissed, or the tooltip was better. The drawer renders `lastTest.error` from
the refreshed list rather than the POST response, so there is one source for
that string and a reload shows the same thing.

**The second confirmation is the connection's own name, typed.** Opening the
panel is the first, and a click can be a misfire. Typing the name cannot be
satisfied by muscle memory, and it forces a reader to look at WHICH row they are
on — the mistake actually worth preventing in a table where forty-five rows look
alike. Trimmed but case-sensitive: two connections can differ only in case.
The panel also says what is lost and what is not, because "delete" on a screen
full of databases is ambiguous in the one direction that matters — Movy deletes
the saved credential, not the database.

**One form component for create and edit.** Two would drift, and the drift would
be silent: a field added to create and forgotten on edit does not break
anything, it just quietly makes that field uneditable forever. The two modes
differ in exactly two ways and both are about identity — the ENGINE is fixed
once saved (changing it would leave every field beneath it describing a
different dialect, and the PATCH handler does not accept it), and the PASSWORD
is required on create and optional on edit.

**A blank password field means "keep the stored one".** It cannot mean anything
else — the stored password is never sent to a client, so the field has nothing
to prefill with. `toConnectionInput` omits the key entirely rather than sending
`''`; the PATCH handler distinguishes the two by length today and a future one
might not. That rule and the delete gate are the two in `app/utils/
connection-form.ts` — pure, so both are tested without a browser.

**`shared/connection-wire.ts` joins the other two wire contracts.** The page had
its own hand-written copy of the connection shape, which was already missing two
fields the serializer sends. `toPublicConnection` is annotated with
`WireConnection` now, so a field the server stops sending is a type error rather
than `undefined` on the screen where someone points a migration at a database.
It also owns the engine list — three, not the four `parseEngine` accepts, since
Snowflake has a `DatabaseType` and no registered Adapter Set.

**Renaming onto a taken name was a 500.** `connections_org_name_uq` was never
caught in the connection handlers, which did not matter while there was no edit
form and no easy way to hit it. Both POST and PATCH now answer 409 with the
sentence, the way the definition handlers already did.

### Verified live

- `pnpm test` — 1227 across 88 files (was 1199/86); 16 new in
  `connection-form.test.ts`.
- `pnpm typecheck`, `pnpm build` — exit 0.
- Driven in a real browser against the dev database, signed in as `editor@`:
  a failed test auto-expanded with the `unreachable` sentence; the badge
  collapsed and re-expanded it; edit showed the engine fixed and the password
  placeholder `Unchanged`, and a rename landed; the delete button stayed
  disabled for an empty box and for the wrong name, enabled on the exact one,
  and the row was gone after; and deleting a connection a definition still uses
  answered *"1 saved migration still uses this connection. Archive it first."*
  in the panel rather than a 500.

---

## Sequence reseed, and testing a connection before it is saved (2026-09-17)

Not a phase. Commit `5ee90bf`. Recorded here 2026-10-22, after the fact — the
commit landed without this file being updated, which the working agreement
above exists to prevent.

**Step 9 now reseeds from the DESTINATION's rows.** A PostgreSQL sequence or an
MSSQL IDENTITY is set from `MAX(col)` on the destination, with the source
counter kept as a floor: PG takes `GREATEST(source next, MAX + 1, START)`, so
the step only ever moves a counter forward. The trigger was a source restored
from a dump whose sequences sat below its own `MAX(id)` — copied verbatim, that
handed the destination the duplicate-key failure the migration was meant to
leave behind. PostgreSQL is the only destination where this was fatal; InnoDB
and `IDENTITY_INSERT` advance their counters as rows load.

`COLUMN_SEQUENCES_SQL` reads the destination catalogue in both shapes PG
records a sequence: `pg_depend` ownership (`serial`, identity) and the
default-expression dependency, which is all a table created by Movy's own
`CREATE TABLE` has. Matching only the first missed exactly the tables Movy
creates. Reading the destination is also what makes the step work for a MySQL
or MSSQL source, whose inspectors report no sequences.

The MSSQL reseed reads the destination too: `SELECT MAX([id]) FROM [users]` is a
syntax error on a MySQL or PG source, so the whole MySQL→MSSQL Pair warned and
reseeded nothing. Full write-up in CLAUDE.md, *Migration flow*.

**The create form can test credentials before they are saved.**
`POST /api/orgs/:slug/connections/test` takes the form's body, opens a
connection with a 10s timeout, closes it, and reports a failure through
`describeConnectionFailure` like the per-row Test does. Nothing is persisted —
there is no row, so no `lastTest`, and the plaintext password never outlives
the request. Gated on `connection:test`.

Offered in **create mode only**. On edit, a blank password means "keep the
stored one" and the form never holds that secret, so a test there could only
test new fields against a password it does not have. The per-row Test button
already covers a saved connection.

### Verified

- `pnpm test` — 1233 across 88 files (was 1227). The six new tests are the PG
  and MSSQL synchronizer reseed cases.
- **Gap:** `connections/test.post.ts` has no unit test; it was exercised by
  hand in the browser only. Its timeout `setTimeout` is also never cleared, so
  a fast connect leaves a 10s timer pending — harmless, but worth fixing when a
  test is written for it.

## R0 — Compose foundations (2026-10-22)

Phase 0 of `docs/runner-service-plan.md` (decisions: ADR 0004, Proposed). Branch
`feat/runner-service-phase-0`. The web container still forks the runner; Phase 6
moves runs to separate runner services.

**What exists.** `docker/Dockerfile` (one image for web, runner and CLI; `build`
target for `migrate`/`seed`; Playwright `e2e` target), `docker-compose.yml`,
`scripts/docker-init.sh` (writes `docker/{movy,meta-db,lab,cli}.env`, never
overwrites), lab fixtures for PG, MySQL and MSSQL (same deterministic shop:
2000/200/5000/15000 rows, a self-referencing FK, a PG sequence left BEHIND its
`MAX(id)`), `apps/web/scripts/seed-lab.ts` (saves the three lab connections in
`acme`), `apps/web/tests/e2e/live-migration.spec.ts`, and `pnpm docker:*` scripts.

### Decisions that are load-bearing

- **The e2e container shares web's network namespace** (`network_mode: service:web`).
  The session cookie is `Secure`; a browser only sends that over plain HTTP to
  `localhost`, so at `http://web:3000` sign-in silently does not stick.
- **Compose never reads the root `.env`** (the CLI's). Env files live in `docker/`
  and are gitignored by the existing `*.env` rule.
- **`docker:init` refuses to overwrite**: a new `NUXT_ENCRYPTION_KEY` makes every
  saved connection undecryptable; a new meta-db password no longer matches the volume.
- **`CI=true` is set per `pnpm install` line, not as an image ENV**, so the runtime
  container does not flip CI-sniffing libraries into CI mode.

### The bugs this work found

1. **`@movy/web` imported `@movy/runner` without declaring it.** It only resolved
   on a dev machine through a stale root `node_modules/@movy/runner` symlink (dated
   Sep 7); a clean lockfile install — the image — crashed on boot with
   `ERR_MODULE_NOT_FOUND`. Fixed: `"@movy/runner": "workspace:*"` in
   `apps/web/package.json` (3-line lockfile change).
2. **PG→MySQL fails for any table with a `serial` column.** The documented
   auto-increment gap is not "degraded", it is fatal on MySQL: the `nextval()`
   default is emitted as a string literal and schema sync rejects the first table.
   Recorded in CLAUDE.md under the gap; the spec carries it as `test.fixme`. Not
   fixed here — it is core translator work. PG→MSSQL unverified, probably the same.
3. **`compose up --wait` fails on a one-shot nothing depends on** (`mssql-init`,
   exit 0). `docker:up` starts everything, then waits on the long-running services only.

### Verified

- `pnpm docker:up`: meta-db, web and the three labs healthy; migrate, seed and
  mssql-init exited 0. Fixture counts identical on all three engines.
- `pnpm docker:e2e`: **9 passed, 1 skipped** (the PG→MySQL `fixme`). Includes the
  simulated mid-run reload, and a REAL PG→PG run whose comparison matches 22,200/22,200.
- Step 9 inside the container: source `orders_id_seq` at 10, destination reseeded
  so the next insert gets id 5001 (MAX is 5000).
- `docker compose run --rm cli`: MySQL→PG, 4/4 tables, 22,200 rows, the CLI's own
  validation 100 %. The log file lands in `./logs` on the host.
- `pnpm test` 1233/1233 and `pnpm typecheck` green. (One earlier run showed 3
  failures while a Docker build saturated the CPU; they passed on every quiet rerun.
  Timing-sensitive tests under load, not a regression, but worth knowing.)
- **Not verified:** a cold build on another machine; Rosetta-less SQL Server on Intel
  is fine by construction but was not run.

### Remaining for the runner plan

R1 next: extract `@movy/db` (+ crypto) and move the run-control modules into
`apps/runner`, no behaviour change; this Compose stack is its gate.

## Fix — auto-increment across engines (2026-10-22)

Done before R1, because the Compose live e2e had shown PG→MySQL failing on its
first table.

- **The flag, not the default, crosses engines.** The PG inspector now sets
  `autoIncrement` for `serial` and identity columns; `carryAutoIncrement` drops a
  foreign `nextval()` default and keeps the flag only where the destination allows
  it (MySQL: the primary key's first column; MSSQL: one; PG: all). The PG
  synchronizer emits `GENERATED BY DEFAULT AS IDENTITY` for a flagged integer with
  no default, so MySQL→PG now has a counter, which step 9 reseeds.
- **Re-runs** needed two diff fixes: primary keys matched by type
  (`constraintKey()`), and alterations whose translated type equals the current one
  dropped. Before, every cross-engine re-run tried to drop the PK and MODIFY every
  column.
- **`unwrapMssql`.** The Nitro bundle inlines `@movy/core` (the `external` entry
  does not do what its comment claimed), and inside it `mssql` arrived as an ESM
  namespace with no `ConnectionPool`. Every in-request MSSQL call failed in a
  production build; dev and the runner were unaffected.
- **Verified:** `pnpm docker:e2e` twice in a row, green: PG→PG, MySQL→PG, PG→MySQL,
  fresh and re-run. MySQL `orders` AUTO_INCREMENT = 5001 although the PG source's
  sequence sat at 10; PG `orders.id` is an identity at 5001 after MySQL→PG.
  `pnpm test` 1261/1261, `pnpm typecheck` clean.
- **Not fixed:** the MSSQL-destination gap above. Next: R1.

## R1 — extract `@movy/db`, move run control into `apps/runner` (2026-10-22)

**No behaviour change**, by construction: sources moved with `git mv` and came out
R100/R099; the five moved tests changed import paths and nothing else.

- **`packages/db` (`@movy/db`)**, CommonJS like core: `src/schema/*`, `migrations/`,
  `drizzle.config.ts`, `createDb(url, { max })`, and the connection-secret half of
  `crypto.ts`. Subpaths `@movy/db/schema` and `@movy/db/crypto`. It builds with
  `module: node16` — under the base config's `node10`, declaration emit cannot name
  Drizzle's inferred table types (TS2883). Output is still CommonJS.
- **Web keeps its imports**: `server/db/schema/index.ts`, `server/db/client.ts` (now
  `useDb()` over `createDb`) and `server/utils/crypto.ts` (re-export + the dev-only
  password hashing) are shims. `db:migrate` / `db:generate` / `db:studio` delegate.
- **`apps/runner/src/agent/`**: `event-writer`, `run-projection`, `journal-tailer`,
  `run-manager`, plus `ingestion.ts` (the four unscoped helpers, out of `runs.repo.ts`).
  Exported as `@movy/runner/agent`; `server/runs/index.ts` imports it.
- **Wiring**: root `build`/`typecheck` include `packages/db`; vitest gains a `db`
  project and anchored source aliases for `@movy/db`, its subpaths and
  `@movy/runner/agent`; the Dockerfile copies `packages/db/dist`; Compose's `migrate`
  calls `@movy/db` directly. One `drizzle-orm` install variant, so types are shared.
- **Deviations from the plan** (recorded in its *Code moves*): ingestion went to the
  runner, not `@movy/db/ingestion`, to avoid a package cycle; `crypto.test.ts` stayed
  in web unchanged; the `MOVY_ENCRYPTION_KEY` alias waits for Phase 2.
- **Dev note**: like core, `@movy/db` and `@movy/runner/agent` resolve to `dist`
  outside the tests, so a fresh clone needs `pnpm build` before `pnpm dev:web` or
  `pnpm seed:dev` (true for core already).
- **Verified**: `pnpm test` 1262/1262 (same count as before); `pnpm typecheck` clean;
  `pnpm build` green; `pnpm docker:e2e` 11 passed, 1 skipped (the PG→MSSQL fixme);
  the moved migrations applied to an empty scratch database (4 migrations, 13 tables).
- **Next — R2**: migration `0004`, the agent (claim, heartbeat, lease, fencing, drain),
  the sweeper, embedded mode; the web stops forking.

## Fix — SQL Server as a destination (2026-10-22)

Between R1 and R2. Four stacked bugs, each found only once the one before it was fixed:
the client pinned no session; `SET IDENTITY_INSERT` ran inside `sp_executesql` and
reverted; INSERTs overran the 2,100-parameter cap; string lengths were dropped on
create (`nvarchar(1)`). Along the way, two that affected other Pairs too:

- **PG numeric precision was lost** on MySQL and SQL Server destinations
  (`decimal(10,0)`, `numeric(18,0)`): data loss that row counts cannot see.
- **A self-referencing table broke load order** for every table under it.

Also: a run that fails on tables now carries a `TablesFailed` error naming them, and a
re-run treats `decimal` and `numeric` as one type.

- **Verified:** `pnpm docker:e2e` twice from an empty SQL Server `movy_dst`, both green
  with no retries: PG→PG, MySQL→PG, PG→MySQL, PG→MSSQL, MySQL→MSSQL. `SUM(orders.total)`
  is 1,074,991.50 on all three engines; `customers.email` is `nvarchar(255)`.
  `pnpm test` 1284/1284, `pnpm typecheck` clean.
- **Still open:** comparisons count rows only; SQL Server cannot ALTER a column a default
  constraint uses (a re-run that changes a type there fails). Next: R2.

## R2 — queue and agent (2026-10-22)

- **Migration `0004_runners`**: `runner_classes` (seeded `default`, inserted before the
  FK that needs it), `runners`, `run_specs`; `runs` gains `runner_class`, `runner_id`,
  `claimed_at`, `lease_expires_at`, a partial queue index, and a nullable
  `journal_path`. Tested on PGlite, including the upgrade over existing runs.
- **The agent** (`apps/runner/src/agent/`): `queue-store.ts` (every statement),
  `runner-agent.ts`, `run-spec-envelope.ts`; `RunManager` gains `liveRunIds()`,
  `terminate()` and the followed run's pid. Embedded in web by default.
- **Web**: launch enqueues a sealed spec in one transaction and wakes the agent;
  cancel cancels a queued run outright (org-scoped), else `cancelling` + forward; the
  new sweeper plugin runs every 10 s; `runs-reattach.ts` became
  `embedded-runner.ts`.
- **Two bugs caught before they shipped**: `RunManager.cancel` on a run it does not
  hold settled it `RunnerGone` (wrong once a run can live on another runner, and wrong
  for a re-attached run, whose pid it did not keep); and the old re-attach query
  listed queued runs, which would have settled every waiting run as vanished on boot.
- **Deviations from the plan**: the spec is deleted at claim, not at settle (no resume
  needs it); `target_lock_key`, the busy index and `definitions.runner_class` wait for
  phase 4, `runner_probes` for phase 5; the runner DB role and grants, and the
  standalone `movy-runner-agent` bin, wait for phase 6, when an agent first runs
  outside the web process. PGlite is a root devDependency (see CLAUDE.md).
- **Verified**: `pnpm test` 1331/1331; `pnpm typecheck` clean; `pnpm docker:e2e` 13/13 —
  the embedded runner registered, heartbeating, claimed every run, and `run_specs` was
  empty afterwards.
- **Next — R3**: the NOTIFY bus, so an agent outside the web process reaches the hub.

## R3 — NOTIFY bus and runner availability (2026-10-22)

- **One path for run events, whatever process ran the run.** `applyProjection` sends
  `NOTIFY movy_run_events '{runId, lastSeq}'` inside its transaction (delivered only on
  commit, never on rollback — tested on PGlite); the web's `RunEventFeed` reads
  `run_events` past a per-run cursor and publishes to the unchanged `RunHub`. The
  embedded agent's in-process `onFlushed` broadcast is removed, so the embedded and
  external cases cannot behave differently.
- **Ordering**: the socket awaits `feed.track()` (cursor = stored `last_seq`) before
  reading the snapshot; a second peer never moves the cursor; reads per run never
  overlap; a reconnect of the dedicated LISTEN connection (`PgListener`) triggers
  `resync()`, since NOTIFY has no replay. `RunEventFeed` is pure and has ten tests.
- **Runner availability**: `movy_runners` NOTIFY on register / state change / sweeper
  offline (never per heartbeat); `RunnerHub` with its own ticket store and
  `/_ws/runners`; refresh on NOTIFY and every 5 s while watched, sending only a
  changed frame; roles revalidated each refresh. `RunnerAvailability.vue` sits in the
  org home's summary rail and as a strip on the runs page; wording from the pure
  `classSentence()`. Capacity is platform-wide, queue depth is this org's, runner ids
  are admin-only.
- **Found while looking at it**: every rebuilt container is a new embedded runner id,
  so offline runners accumulated. The admin list drops a runner an hour after it went
  offline; the sweeper deletes it after a day.
- **Verified**: `pnpm test` 1370/1370; `pnpm typecheck` clean; `pnpm docker:e2e` 16/16,
  including the mid-run reload over the new feed and the three panel tests; screenshots
  at 1280 and 375.
- **Not done**: "Start a runner" (phase 6, needs a provisioner); queue reasons in the UI
  (phase 4, with the destination lock).

## R4 — destination lock and runner classes (2026-10-23)

- **One run per destination, across orgs.** The launch hashes engine, host, port and
  database into `runs.target_lock_key` (`server/runs/target-lock.ts`; never
  serialised, null for a replay). The claim skips a queued run whose key a running or
  cancelling run holds, so it waits while younger runs to other databases go ahead;
  the partial unique index `runs_target_busy_uq` refuses the second of two claims made
  at the same instant, and the claim then asks again. Two spellings of one server
  (`localhost`, `127.0.0.1`) are two keys: the lock guards the common mistake.
- **Why a run is queued** — `no_runner`, `destination_busy`, `runners_busy`,
  `starting` — is derived per request (`GET …/runs/:id/queue`, `server/runs/queue-state.ts`),
  never stored, and polled by `QueueNotice.vue` every 5 s while the run is queued.
  Another org's run holding the destination is never named; "ahead of it" counts this
  org's runs only, the same rule as the runners panel.
- **Runner classes** come from `MOVY_RUNNER_CLASSES_FILE` (Compose ships
  `docker/runner-classes.json`: `default`, `large` above 20 GB). Parsed strictly in
  `@movy/runner/agent` (unknown keys rejected, exactly one default) and upserted in one
  statement at boot; the embedded agent awaits it before registering. A class dropped
  from the file is kept, marked `configured = false`, loses the default, and is hidden
  from the panel and selector. A broken file is logged and the table keeps what it had.
- **A class per definition** (`migration_definitions.runner_class`, null follows the
  default), and a Runner selector on the definition form and the review screen, each
  option with its availability sentence. At launch: the body's class, else the
  definition's, else the default (`chooseRunnerClass`); a definition whose class was
  dropped runs on the default rather than becoming unlaunchable. The run header shows
  the class.
- **Size in bytes**: optional `ISchemaInspector.getTableSizeEstimates` — PG
  `pg_total_relation_size`, MySQL `DATA_LENGTH + INDEX_LENGTH`, MSSQL used pages from
  `sys.allocation_units`. Advisory, so each answers an empty map rather than failing the
  preview, which then says "size unknown". The preview carries per-table and total bytes
  and `runnerSuggestion` (highest threshold exceeded); the review screen shows it as a
  hint with a "Use it" button, never as a switch.
- **Found while testing it**: a queued run cancelled outright emitted no event, so its
  page said "Queued" forever. `applyRunRow` takes the cancel response (and a refresh when
  the queue notice finds the run gone) and only ever moves the status forward. And
  `host-death.test.ts` was flaky because its host died on a 1.2 s timer before tsx had
  started the runner under load; the host now dies once the journal has lines.
- **Verified**: `pnpm test` 1421/1421 (twice, after the host-death fix); `pnpm typecheck`
  clean; `pnpm docker:e2e` 19/19, including sizes read live from all three engines and
  the queued-for-`large` run's reason and cancel; screenshots at 1280 and 375 of the
  queue notice and the preview with a suggestion (threshold lowered for the shot only).
- **Not done / noticed**: the lock under true concurrency (two agents) needs phase 6's
  separate runner services. The preview counts column alterations the run will drop
  (a PG→MySQL re-run shows "21 columns to alter"; `SyncSchemaUseCase` filters them) —
  pre-existing, worth fixing in `buildPreview`.


## R5 — probes: Test and Preview from a runner (2026-10-23)

- **Why**: a runner can sit on a different network from the console. "It connects from
  here" says nothing about whether a `large` runner reaches the same host, and the first
  place that used to show up was a failed run.
- **One implementation, two hosts.** `apps/runner/src/probes/` (`@movy/runner/probes`)
  holds `testConnection`, `inspectForPreview` and the scrubbing (`safe-error.ts`, moved
  from web, which re-exports it so the five callers did not move). The in-request
  handlers and the agent's probe worker call the same functions, so a failure is the same
  sentence from either. `buildPreview` stays in web and reads one `PreviewInspection`
  shape (maps as entries) from either path.
- **The probe queue** is `runner_probes` (migration `0007`), shaped like the run queue:
  insert + `NOTIFY movy_probes` in one statement; claim with `SKIP LOCKED`, which also
  sets the sealed request (`probeAad(orgId, probeId)`) to NULL; complete +
  `NOTIFY movy_probe_done` in one statement; the waiting request takes the result with
  `DELETE … RETURNING`, scoped to its org. The sweeper deletes expired rows.
- **The wait** (`server/probes/run-probe.ts`): no online runner of the class with
  `probe_slots > 0` is an immediate 503 `{reason: 'no_runner', runnerClass}` and nothing
  is queued. Otherwise it waits on the NOTIFY but re-reads every second anyway (a NOTIFY
  can be missed, or reach a different replica). Timeouts are 15 s for Test and 60 s for
  Preview; past that it is a 504 and the row is deleted, so a late runner has nothing to
  write to.
- **The worker** (`apps/runner/src/agent/probe-worker.ts`) has its own slots
  (`MOVY_RUNNER_PROBE_SLOTS`, default 2), separate from run slots: a runner busy with a
  long migration still answers "can you reach this database?". A request it cannot
  decrypt or whose version it does not know is answered in its own words, never the
  request's. The embedded agent starts it after registering and stops it first on close.
- **Recorded**: `connections.last_test_via` (`web` or the class), on the wire as
  `lastTest.via` for every role (a class name, never a host); the row says "from the
  Default runner" when it was not the console.
- **UI**: one "Test from" selector per connections page, which also drives the create
  form's test-before-save; "Inspect from" beside Preview on the review screen, with
  "Inspected from the … runner." under the result. Compare's drift view stays in-request
  (decision 6).
- **Tests**: probe SQL against PGlite (12), the worker (6), seal/open and the executor's
  result mapping (7), `testConnection` (3), a console↔runner round trip through PGlite
  with a real worker (4), `via` parsing and error mapping, waiters, display. E2E
  `probes.spec.ts`: a test from the default runner shows in its row; a preview from the
  runner lists the same tables as the console's; the review screen names where it
  inspected; `via: 'large'` with no large runner is a 503 in under 5 s.
- **Gate**: `pnpm docker:e2e` 23/23 (19 earlier + 4 in `probes.spec.ts`). Its first run
  failed on the test, not the app: `getByLabel('Source', { exact: true })` never resolves
  on the review screen, because the `<label>` wraps the `<select>` and Playwright's label
  text then includes every option. The spec matches `getByRole('combobox', { name })`,
  which uses the computed accessible name. Both selectors checked at 1280 and 375: no
  page overflow; the connections table scrolls inside its own container, as before.

## R6 — runner services and provisioning in Compose (2026-10-25)

- **Why**: until now every run still executed inside the web container (the embedded
  agent). A console restart, an OOM in a big migration, or a runner that needs a
  different network all took the console with them.
- **`movy-runner-agent`** (`apps/runner/src/agent-main.ts`): the same `RunnerAgent`,
  `RunManager`, `EventWriter` and `ProbeWorker` the console embeds, wired from the
  environment by `readAgentConfig` (pure; a bad value is refused at boot with exit 64,
  never defaulted). No port. It LISTENs on two new channels, `movy_runs {runnerClass}`
  (sent in the enqueue transaction) and `movy_run_cancel {runId}` (sent by
  `requestCancel`), plus `movy_probes`; the web listener forwards the same two to an
  embedded agent, for a run launched through another replica. `PgListener` moved into
  `@movy/runner/agent`. `agent.cancel` is now idempotent per run, since a NOTIFY and the
  console's fast path can both deliver one.
- **Least privilege**: `movy_runner` is created — or its password reset — by the `migrate`
  service after the migrations (`ensureRunnerRole`, `RUNNER_GRANTS` in `@movy/db`).
  `REVOKE ALL` then the list, so a dropped grant is dropped from a live deployment too.
  Tighter than the plan: no INSERT on `runs` or `runner_probes`. Runners read
  `docker/runner.env` only (role URL + encryption key), never `movy.env`.
- **Compose**: `web` lost `init`, `MOVY_RUNNER_ENTRY`, `MOVY_JOURNAL_DIR` and the journals
  volume and sets `MOVY_EMBEDDED_RUNNER=false`. `runner-default` (1 replica, 2 slots) and
  `runner-large` (0) with `init`, `stop_grace_period: 2m`, replica-local journals and the
  `movy.runner-template` label. `docker-compose.provisioner.yml` mounts the socket into
  `web` as root, with `MOVY_PROVISIONER=docker` and `MOVY_AUTOSCALE=true`. Scripts:
  `docker:scale N`, `docker:up:provisioner`; `docker:down` removes provisioned runners
  first (Compose does not know them, and they hold the network).
- **Provisioning** (`server/runners/`): `ManualProvisioner` answers
  `docker compose up -d --scale runner-<class>=<n+1>` (`MOVY_PROVISIONER_COMMAND`
  overrides it); `DockerProvisioner` clones a template container through the Engine API
  (`docker-engine.ts`, five calls, no library) with the class's limits, no restart
  policy, no Compose labels, `movy.provisioned` and `MOVY_RUNNER_PROVISIONED_BY=docker`.
  `POST …/runners/scale` needs the new `runner:scale` (admin only). The sweeper replica
  removes exited clones and, in auto mode, scales a class with queued work that is not
  blocked on its destination, no free slot and room under `max_replicas`, once per 60 s.
- **UI**: `StartRunner.vue` under a `no_runner` queue notice and beside "Test from" /
  "Inspect from" on a class with nobody online; absent without `runner:scale`. The
  manual answer is a read-only command with Copy.
- **Tests**: config (7), idle watch (2), self-fencing (3), idempotent cancel, re-attach
  scoping, the busy reset; the role against PGlite *as the role* — every table outside
  the grant list refused, structurally, so a new table is covered — and every agent
  statement run as `movy_runner` (5); provisioners (15, incl. the clone body), auto mode
  (4), capacity and demand SQL (4), `scaleSentence`, `runner:scale`; the agent binary's
  boot refusals as a process (2). E2E `runner-services.spec.ts` (Compose only): a run is
  claimed by a container, never `embedded-*`; an admin offered a runner gets the command
  (or, under the override, a started runner); an editor is not offered one and gets 403.

### The bugs this work found

- **A network partition left the agent heartbeating but never claiming again.** A query
  sent on a socket that died in the partition never settles — `pg` has no client-side
  timeout by default — and `wake()` kept returning that pending `claiming` promise.
  Heartbeats took fresh connections, so the runner looked healthy in the panel while the
  next run sat `starting` forever. Fixed with a 30 s `query_timeout` and
  `connectionTimeoutMillis` on the agent's pool (`createDb` options) and TCP keepalive
  on the pool and the LISTEN connection; the stuck queries now fail as
  "Query read timeout" and the next wake claims. Found only by
  `docker network disconnect` — no unit test models a socket that never answers.
- **The docker provisioner could not start a large runner.** The clone copied the
  template's `MemorySwap` (sized for the 1 GB default runner) and raised `Memory` to 8 GB;
  Docker refuses swap below memory. The clone's swap is now its own memory.
- **An offline runner kept its last `busy` count**, so the admin list showed a stopped
  runner as busy. `setRunnerState('offline')` zeroes it.
- **Not a bug, a gap closed**: an agent cut off from the database kept its runs going
  until it could hear the sweeper had settled them. It now stops them itself once a full
  lease passes without a successful heartbeat — before, or as, the sweeper settles them.

### Verified (Compose, 2026-10-25)

Against the plan's Verification list:

1. `pnpm docker:up`: every service healthy or exited 0; `migrate` logged
   `movy_runner is up to date`; the runner registered as the role. ✔
2. `docker compose stop runner-default` with nothing running: offline at once (it says
   so itself on the way out, rather than waiting 20 s for the sweeper). ✔
3. Large run with no large runner: `queued: no runner`, Start a runner → the command
   (manual); under the override → a container, which claimed the run. ✔
4. Two orgs, one `movy_dst`, real PG→PG runs: the second showed `destination_busy` with
   no run named (another org's), then ran a second after the first settled; both
   succeeded. ✔
5. `docker compose restart web` mid-run: the run finished `succeeded`, events 1…118, no
   gap, no duplicate, read back through the API. The browser reload is
   `run-lifecycle.spec.ts`. ✔
6. `docker compose kill runner-default` mid-run: `failed` / `RunnerVanished` with the
   partially-applied message ~32 s after the kill (lease 30 s + one sweep); not retried. ✔
7. `docker network disconnect` for 45 s mid-run, then reconnect: the agent logged the
   fence, no runner process survived, no events after the settle, and — after the fix
   above — the next run was claimed within 4 s. Simulated, so "no writes to `movy_dst`"
   is shown by the fence rather than by row counts. ✔
8. `docker compose stop runner-default` mid-run: drained 14 s, the run `succeeded`. ✔
9. Size suggestion: R4. A large run launched with zero large runners was claimed by the
   runner auto mode started ~10 s later. ✔
10. Test from `large` with none: 503 in 3 ms → Start a runner → registered in 1 s with
    8 GB / 4 CPUs / no restart → retry `ok`, connection shows `via: large`. Editor: 403. ✔
11. Viewer counts without ids: `runner-availability.spec.ts`. ✔
12. `pnpm docker:down && pnpm docker:up`: users, orgs, connections, definitions, runs and
    run events identical before and after. `down -v` not run against a working meta-db;
    it is Compose's own volume removal. ✔
- **Idle exit**: the clone auto mode started exited 0 ten minutes after its last run
  (12:03:44 → 12:13:44), the sweeper removed it within 10 s, and its row went offline
  with `busy = 0`. Class cap: a second Start while at `max_replicas` answered
  `at_capacity` and started nothing. ✔
13. `pnpm docker:e2e` 26/26 (23 + 3 in `runner-services.spec.ts`); `pnpm test` 1528/1528;
    `pnpm test:coverage` above its floor (66.83 / 57.7 / 68.69 / 67.58).

## PR #8 review fixes (2026-10-25)

- **Why**: a multi-agent review of the runner-service PR, then a deeper pass over the
  areas it covered lightly. Twenty-two commits on `feat/runner-service-phase-0`; each
  fix landed with a test that failed first.
- **Platform operators** (the one design change; ADR 0004, amendment 1). Orgs are
  self-serve, so the org-admin `runner:scale` let any signed-in user start shared
  runners and read every runner's hostname. Acting on shared infrastructure is now a
  platform operator's: a `platform_admins` row (migration `0008`, granted with who and
  when — the SaaS case) or an email in `MOVY_PLATFORM_ADMINS` (self-hosted, or a SaaS's
  first operator). Read from the database on every check and every runner-hub refresh.
  `/api/me` answers `platformAdmin`; `pnpm seed:dev` adds `ops@movy.local`, and
  `admin@` stays a plain org admin the e2e specs show being refused.
- **Reliability**:
  - the heartbeat judged fencing by the live set read after its query, so a run claimed
    during it was killed as swept, or never fenced at all;
  - a failed cancel was an unhandled rejection that also blocked any retry;
  - the embedded agent tried its start once; the live feed waited for a notification
    that, after `run_finished`, never comes;
  - `PgListener.stop()` during a reconnect leaked a LISTENing connection;
  - a non-JSON 2xx from Docker threw out of a response listener and crashed the console;
  - the provisioner missed created-but-unstarted clones and could pass `max_replicas`;
  - a shutdown waited on probes before it stopped claiming.
- **Consistency**: one class-name rule (`web` reserved, counts within `integer`); one
  reading of `MOVY_RUNNER_SLOTS`, which the embedded agent used to default silently;
  probe requests, runner answers and the run spec envelope checked, never cast; a failed
  spec read reported as `RunSpecUnavailable`, not "spec gone".
- **Cleanup**: `EventWriter.onFlushed` removed; NOTIFY payload parsing and the
  simulation recording each resolved in one place; `agent-main`'s `run()` split;
  `server/runs/host-paths.ts`. `run-manager.ts` was left alone: its `reattach()` is 20
  lines, not the 100 the first review reported.
- **New tests**: `PgListener` (first ever), the Docker socket client against a real
  HTTP server, `sweepTick`, a probe answered with no NOTIFY, the heartbeat race, the
  provisioner under concurrent requests, operator resolution against PGlite.

### Verified

- `pnpm test`, `pnpm typecheck` and `pnpm build` after every commit group.
- `pnpm docker:e2e`: **28/28** on a rebuilt stack (migration `0008` applied). The first
  run failed one test: `runner-services.spec.ts` still read runner ids as `admin@`, who
  since the operator change gets class counts but no `runners` list. The spec now signs in
  as `ops@`, and reads the online count from `classes`, which every role gets.
- Host `pnpm test:e2e` (embedded agent): **12/12**; the 16 skips are the Compose-only
  specs (`live-migration`, `probes`, `runner-classes`, `runner-services`). A cold
  `nuxt dev` can outlast Playwright's 120 s `webServer` timeout; start it yourself and set
  `MOVY_E2E_EXTERNAL_SERVER=1` (plus `MOVY_E2E_BASE_URL` if Nuxt picks another port).

### Tracked after this release

Everything below is outside PR #8 and has its own issue:

| Issue | What |
|-------|------|
| [#9](https://github.com/EduardoPetrini/nodejs-movy-data/issues/9) | simultaneous launches can pass `max_concurrent_runs` |
| [#10](https://github.com/EduardoPetrini/nodejs-movy-data/issues/10) | two web replicas can start a runner past `max_replicas` |
| [#11](https://github.com/EduardoPetrini/nodejs-movy-data/issues/11) | runner phase R7: Kubernetes (Deployment per class, KEDA, shared tickets) |
| [#12](https://github.com/EduardoPetrini/nodejs-movy-data/issues/12) | runner phase R8: runner classes edited in the UI by platform operators |
| [#13](https://github.com/EduardoPetrini/nodejs-movy-data/issues/13) | comparisons count inside the request and time out on large databases |
| [#14](https://github.com/EduardoPetrini/nodejs-movy-data/issues/14) | a stalled run reaches only the server log |
| [#15](https://github.com/EduardoPetrini/nodejs-movy-data/issues/15) | comparisons check counts, never values |
| [#16](https://github.com/EduardoPetrini/nodejs-movy-data/issues/16) | unit tests for the test-before-save endpoint |
| [#17](https://github.com/EduardoPetrini/nodejs-movy-data/issues/17) | coverage to the 80 % target |
| [#18](https://github.com/EduardoPetrini/nodejs-movy-data/issues/18) | axe checks, screen-reader and `prefers-contrast` pass |
| [#19](https://github.com/EduardoPetrini/nodejs-movy-data/issues/19) | automate the chaos steps 5–7 of the runner verification |
| [#20](https://github.com/EduardoPetrini/nodejs-movy-data/issues/20) | a production Compose override (no seed or lab, SSO, TLS) |
| [#21](https://github.com/EduardoPetrini/nodejs-movy-data/issues/21) | the new organisation form has no Cancel button |

### Second review pass (2026-10-25)

Eleven more findings, each fixed with a test that failed first:

- **Fencing** (`runner-agent.ts`, `run-manager.ts`): a fenced run is SIGKILLed, not sent
  the cooperative SIGTERM; a run recovered after a restart is owned and fenced like a
  claimed one, by its stored pid; leases have a per-run deadline measured from the
  renewal's send time and checked on a 1 s timer, 5 s before expiry, never only after a
  heartbeat fails; a run that finished between beats leaves `owned`.
- **Cancel before launch** (`ingestion.ts`): `run_started` no longer turns `cancelling`
  back into `running`, which hid the cancel from every later heartbeat.
- **Swept runs reach the page**: the sweep NOTIFYs `movy_run_settled`, and the console
  pushes a cohort-neutral `run_status` frame, applied with `applyRunRow`.
- **Runner hub**: one membership object in both indexes, so an operator promoted and
  then revoked on a live socket leaves the operator room.
- **Primary keys** (`constraint-key.ts`): matched by type AND ordered columns, so a key
  over different columns is replaced rather than kept.
- **Probes**: a per-kind execution deadline (15 s test, 60 s preview — the console's own
  waits) aborts the probe, closes its connections and frees the slot.
- **Runner classes**: a failed upsert is retried (5 s timer and the next caller) instead
  of memoised; a broken file still is not.
- **Docker provisioner**: a clone whose start fails is removed, and `cleanup` removes one
  left `created` for over two minutes, so neither holds the class at capacity.

`pnpm test` 1614/1614, `pnpm typecheck`, `pnpm build` green. Compose E2E not re-run.

### Third review pass (2026-10-25)

Five findings, each fixed with a test that failed first:

- **Fencing at startup** (`runner-agent.ts`): the lease watchdog is armed BEFORE the
  first beat. That beat awaits a heartbeat and the whole claim loop, so a heartbeat that
  hung left recovered runs writing unchecked. A first beat slower than one check
  interval now stops them: their remaining lease is unknown.
- **A claim answered late** (`runner-agent.ts`): leases are checked synchronously right
  before `launch`, not only on the timer, so a claim whose answer arrived past its
  deadline is never started.
- **Preview abort** (`pg-connection.adapter.ts`, `inspect-for-preview.ts`):
  `IDatabaseConnection.abort?()` cancels in-flight statements on the server
  (`pg_cancel_backend` on a connection of its own), then ends. `pool.end()` alone waits
  for busy clients, so a blocked catalogue query outlived the freed slot. `end()` is now
  idempotent. MySQL and MSSQL have no `abort()` yet and are only closed.
- **Every settlement is announced**: migration `0009` adds the `runs_settled_notify`
  trigger, which NOTIFYs `movy_run_settled` whenever a run's status becomes terminal,
  whoever wrote it. Only the sweeper did before; a fenced, crashed or refused run left
  the page on "running". The sweep's hand-written NOTIFY is gone.
  `run-settled-notify.test.ts` drives every settlement path against the real migrations.
- **Settlements across a LISTEN reconnect** (`server/runs/settled-status.ts`): on
  reconnect the console re-reads every watched run and pushes the settled ones, as the
  event feed re-reads events. NOTIFY has no replay.

`pnpm test` 1637/1637, `pnpm typecheck`, `pnpm build` green. `pnpm docker:e2e`
**28/28** on a rebuilt stack (2026-10-27), covering the second and third passes and
migration `0009`. Host `pnpm test:e2e` (embedded agent) **14/14** the same day; the 14
skips are the Compose-only specs (`live-migration`, `probes`, `runner-services`).
`runner-classes` now runs on the host too, whenever the host meta-db has a `large`
class with no runner online.

### Out of scope, found on the way

- Launching checks `countActive()` and then enqueues without a lock, so two
  simultaneous launches can pass `max_concurrent_runs`. On `main` before this branch:
  #9 (lock the org row inside the `enqueue` transaction).
- Two web replicas asked to start a runner within the same second can pass a class's
  cap by one; documented in CLAUDE.md, tracked in #10.

