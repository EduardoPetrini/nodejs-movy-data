# Web UI — progress and handoff

Working branch: **`feat/monorepo-restructure`** (7 commits ahead of `main`).
Plan: `~/.claude-personal/plans/let-s-a-web-ui-vectorized-codd.md`.

Phases 0, 1 and 2 are done. **Phase 3a step 1 (the runner) is done**; steps 2-4
are next.

> This covers the **web UI** work. `docs/implementation-plan.md` remains the
> CLI-side plan (engine roadmap, type maps, Pair status) and is unaffected.

---

## What exists now

```
packages/core/   @movy/core    the hexagon; CommonJS, no I/O entry points
apps/cli/        @movy/cli     the original interactive CLI
apps/runner/     @movy/runner  the run driver: argv, stdin, signals, IPC, journal
apps/web/        @movy/web     Nuxt 4: orgs, RBAC, encrypted connections
```

`pnpm` workspaces. 854 tests. Coverage 62.04 / 46.46 / 65.94 / 62.82 over core +
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
  six tables. Distinct from any database being migrated.
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

## Next: Phase 3a steps 2-4

1. `RunManager` in Nitro: fork with `detached: true`, `EventWriter` batching into
   `run_events`, projections into `run_steps` / `run_table_progress`,
   `JournalTailer` re-attach on boot. Needs new Drizzle tables — `runs`,
   `run_events`, `run_steps`, `run_table_progress` — none exist yet. Import the
   IPC types type-only from `@movy/runner/protocol`.
2. Socket.IO under Nitro with **org-scoped rooms** and the two log cohorts
   (`:full` for editor/admin, `:redacted` for viewer). Timebox the Nitro
   integration to half a day — the sidecar fallback is designed for.
3. `run-reducer.ts` (pure, outside the store) plus `RunTimeline`,
   `TableProgressGrid`, `LogStream`, all driven by the simulator.

Demo for 3a: click Run, watch a simulated migration draw itself, kill the dev
server mid-run, restart, and watch the UI re-attach and catch up.

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
  that silently re-copies everything.
- Docs still to update in Phase 5: `CONTEXT.md` (Org, Run, Timeline, Definition),
  `README.md`, and ADRs 0002 (run execution) and 0003 (org tenancy).
