# Web UI — progress and handoff

Working branch: **`feat/monorepo-restructure`**.
Plan: `~/.claude-personal/plans/let-s-a-web-ui-vectorized-codd.md`.

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

*Last reviewed: 2026-09-08. 1094 tests, 79 files, green.*

| Phase | State | Notes |
|-------|-------|-------|
| 0 — monorepo restructure | **DONE** | three workspaces, history preserved |
| 1 — core made drivable | **DONE** | event contract, sinks, `--json-events` |
| 2 — web shell, auth, orgs, connections | **DONE** (2026-09-08) | org creation, members, invitations, org switcher |
| 3a — live timeline, simulated | **DONE** | runner, RunManager, socket, UI |
| 3b — real runs | **DONE** (2026-09-08) | definitions, PairSelector, preview; real PG→PG verified |
| 4 — history, replay, stats, drift | **TODO** | nothing built |
| 5 — hardening | **TODO** | light theme + reduced-motion landed early |

### Remaining work

**Phase 4 — nothing built.** Keyset pagination + sparklines on the run ledger
(today: a plain list on a 3s poll), `validation_runs` + the compare page +
`CountComparisonTable`, `SchemaDiffView`, `/api/stats/summary` and an org
dashboard — there is no org home page at all; sign-in lands on `/connections`.

**Phase 5 — nothing except the theme work.** Full `AbortSignal` plumbing +
`WorkerPool.terminate()`, retention task, per-run event cap, heartbeat
watchdog, an error taxonomy (auth failure vs unreachable host vs missing
permission), keyboard-navigation and focus-ring pass, ratchet coverage toward
80 % (now 62.04 / 46.46 / 65.94 / 62.82), and the docs: ADR 0002 (run
execution), ADR 0003 (org tenancy), `CONTEXT.md` (Org, Run, Timeline are still
undefined there), `README.md`. `CLAUDE.md` is current.

**Verification gaps.** No Playwright and no E2E anywhere in the repo, so the
plan's end-to-end gate (sign in → org → connection → run → reload mid-run →
catch up) is unwritten — Phase 3b's real run was driven by hand and by curl,
not by a test that will run again tomorrow. There is also **no
credential-redaction test**, which the plan calls the worst plausible bug in
this project. Google SSO is wired but
needs `NUXT_OAUTH_GOOGLE_CLIENT_ID` / `SECRET`.

**Known bugs, tracked.** [#5](https://github.com/EduardoPetrini/nodejs-movy-data/issues/5)
query migration crashes on a non-PostgreSQL destination,
[#4](https://github.com/EduardoPetrini/nodejs-movy-data/issues/4) `MssqlQueryAnalyzer`
unreachable, [#3](https://github.com/EduardoPetrini/nodejs-movy-data/issues/3)
MSSQL sequence reset assumes an `id` column.

---

## What exists now

```
packages/core/   @movy/core    the hexagon; CommonJS, no I/O entry points
apps/cli/        @movy/cli     the original interactive CLI
apps/runner/     @movy/runner  the run driver: argv, stdin, signals, IPC, journal
apps/web/        @movy/web     Nuxt 4: orgs, RBAC, connections, definitions, runs
```

`pnpm` workspaces. 1094 tests. Coverage 62.04 / 46.46 / 65.94 / 62.82 over core +
CLI + runner, ratcheted upward only; `apps/web` ratchets separately so a young
app neither dilutes the core number nor hands it a free jump.

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
importing them from `@movy/core`, because core is CommonJS and externalised for
Nitro; `step-order.test.ts` fails if the copy ever drifts.

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
- **`runs/index.vue` renders dates through `toLocaleString()`**, which resolves
  against Node's locale on the server and the browser's on the client and warns
  on hydration. `members.vue` pins `en-CA`; do the same there.
- **Composite FKs on `runs` need PostgreSQL 15+.** `0001` uses the
  column-scoped `ON DELETE SET NULL (<column>)`, hand-edited because drizzle-kit
  emits a bare `SET NULL` that would try to null `org_id`. `migration-sql.test.ts`
  fails if a regenerated migration drops it.
- Docs still to update in Phase 5: `CONTEXT.md` (Org, Run, Timeline, Definition),
  `README.md`, and ADRs 0002 (run execution) and 0003 (org tenancy).
