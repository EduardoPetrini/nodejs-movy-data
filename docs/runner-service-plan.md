# Plan: Runners as an independent, scalable service (with Docker Compose)

> **Status (2026-10-23): phases 0–4 built**; 5–8 to go. Progress and what each phase
> found: `docs/web-ui-progress.md` (R0–R4). Decisions are recorded in
> [ADR 0004](adr/0004-runner-service.md). This plan absorbs the earlier
> Docker plan: Compose foundations are Phase 0, runner services are Phase 6.

## TLDR
- The web app stops forking runners. Launching a run becomes **inserting a row**. Long-lived **runner agents** claim rows from Postgres and fork the existing `movy-runner` child, which is unchanged.
- **Postgres is the queue and the bus.** No Redis and no BullMQ. Claiming uses `FOR UPDATE SKIP LOCKED` on `runs`; wake-ups and live updates use `LISTEN/NOTIFY`, which is delivered only on commit.
- **Runner classes** (`default`, `large`, …) are pools with fixed CPU and memory. The launch form picks a class, and the review screen suggests a bigger one based on the **source tables' size in bytes**.
- **Runners heartbeat every 5 s**, so the UI shows live availability even when nothing runs. When a run is queued and no runner can take it, the UI can start one, manually or automatically.
- **One run per destination at a time**, across all orgs. A partial unique index enforces it.
- **Test connection and Preview** work both ways: in the web request (unchanged) and on a chosen runner class.
- **Docker Compose** brings up everything: the metadata DB, migrations, seeds, the web UI, runner pools per class, Postgres/MySQL/SQL Server test databases, the CLI and the Playwright e2e suite.
- Built so Kubernetes is a deployment change: one Deployment per class, scaled by KEDA.

---

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Queue technology | Hand-rolled on `runs` (no pg-boss, no BullMQ/Redis) |
| 2 | Runner model | Long-lived pools per class; ephemeral Job-per-run deferred |
| 3 | Tenancy | Shared by the platform; per-org pools later via nullable `runner_classes.org_id` |
| 4 | Trust | Runners are trusted infra: they hold the encryption key and meta-DB credentials (least-privilege role in Phase 2) |
| 5 | Same destination twice | Refused at claim time by a partial unique index, across orgs |
| 6 | Test and Preview | Both paths: in-request **and** "from runner <class>". Compare stays in-request |
| 7 | SQL-semantics tests | **PGlite** (in-process Postgres) as a dev dependency |
| 8 | Large-run signal | **Source table size in bytes**, not row count |
| 9 | Class configuration | Deploy-time file now; **admin editing in the UI is the next phase** (Phase 8) |
| 10 | Docker Compose | Part of this plan (Phases 0 and 6) |

## Target shape

```
            ┌──────────────── Postgres (meta) ────────────────┐
            │ runs (= queue) · run_specs (encrypted)           │
            │ runners (heartbeats) · runner_classes            │
            │ runner_probes · run_events + projections         │
            └──▲──────────┬─────────────────▲─────────▲───────┘
   INSERT queued│  LISTEN  │ movy_run_events │ claim   │ events tx + NOTIFY
   + run_spec   │  movy_runners, movy_probe_done         │ heartbeat (lease)
        ┌───────┴──────────▼──┐      ┌───────┴─────────┴─────────┐  × N per class
        │ web (Nuxt)          │      │ runner agent (class X)    │
        │ API · sockets · hub │      │  ├ claim → fork movy-runner│  child contract
        │ sweeper · provisioner│     │  ├ EventWriter → DB+NOTIFY │  unchanged: stdin
        │ never forks*        │      │  └ probes (test/preview)   │  spec, journal,
        └─────────────────────┘      └───────────────────────────┘  exit codes
   * unless MOVY_EMBEDDED_RUNNER=true (dev): the same agent, in-process
```

### What stays exactly as it is
- `apps/runner/src/main.ts` and its contract: the spec on stdin, the journal written before IPC, exit codes 0/1/2/64/70, `--simulate`, and `composeSink` redaction. **`apps/runner/tests/process/` must pass unmodified.**
- `run_events` keyed on `(run_id, seq)`, `ON CONFLICT DO NOTHING`, the log-event cap, retention.
- The org concurrency gate at launch (`repos.runs.countActive()` against `maxConcurrentRuns`). It counts queued runs too, so an org can't flood the queue.
- No retries, no resume. A lost run settles `failed` / `RunnerVanished` with the existing "may be partially applied" message.
- The 30-minute stall **report**. A silent child of a live runner keeps its lease (see Fencing).

## Data model (migration `0004_runners.sql`)

```sql
CREATE TABLE runner_classes (
  name                text PRIMARY KEY,         -- 'default', 'large'
  label               text NOT NULL,
  description         text,
  cpu_millis          integer,                  -- informational; the platform enforces limits
  memory_mb           integer,
  max_replicas        integer NOT NULL DEFAULT 1,
  suggest_above_bytes bigint,                   -- decision 8: suggest this class above N source bytes
  is_default          boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
INSERT INTO runner_classes (name, label, is_default) VALUES ('default', 'Default', true);

CREATE TABLE runners (
  id                text PRIMARY KEY,       -- stable: MOVY_RUNNER_ID ?? hostname (pod name / container id)
  class             text NOT NULL REFERENCES runner_classes(name),
  version           text NOT NULL,          -- @movy/runner version + spec versions supported
  slots             integer NOT NULL,       -- concurrent runs (MOVY_RUNNER_SLOTS, default 1)
  busy              integer NOT NULL DEFAULT 0,
  probe_slots       integer NOT NULL,
  state             text NOT NULL,          -- 'online' | 'draining' | 'offline'
  provisioned_by    text,                   -- 'docker' | null — idle-exit applies only to these
  started_at        timestamptz NOT NULL,
  last_heartbeat_at timestamptz NOT NULL
);

ALTER TABLE runs
  ADD COLUMN runner_class     text NOT NULL DEFAULT 'default' REFERENCES runner_classes(name),
  ADD COLUMN runner_id        text,
  ADD COLUMN claimed_at       timestamptz,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN target_lock_key  text,          -- sha256(engine|host|port|database); never serialised
  ALTER COLUMN journal_path DROP NOT NULL;   -- now the agent's local path, set at claim

ALTER TABLE migration_definitions
  ADD COLUMN runner_class text REFERENCES runner_classes(name);   -- null = default

CREATE UNIQUE INDEX runs_target_busy_uq ON runs (target_lock_key)
  WHERE status IN ('running', 'cancelling');
CREATE INDEX runs_queue_idx ON runs (runner_class, created_at) WHERE status = 'queued';

CREATE TABLE run_specs (                     -- deleted when the run settles
  run_id       uuid PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  spec_version smallint NOT NULL,
  ciphertext   bytea NOT NULL                -- encryptSecret(JSON(spec), specAad(orgId, runId))
);

CREATE TABLE runner_probes (                 -- test / preview executed on a runner
  id           uuid PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind         text NOT NULL,               -- 'test' | 'preview'
  runner_class text NOT NULL REFERENCES runner_classes(name),
  status       text NOT NULL DEFAULT 'queued', -- queued | running | done
  runner_id    text,
  ciphertext   bytea NOT NULL,              -- encrypted request (holds passwords)
  result       jsonb,                       -- already scrubbed by describeConnectionFailure
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
```

The `RunStatus` union is unchanged: `queued` → `running` happens **at claim**.

**Class configuration (decision 9):** a web plugin upserts `runner_classes` at boot from `MOVY_RUNNER_CLASSES_FILE` (JSON, validated; unknown keys rejected). Classes missing from the file are **never deleted**, because runs and definitions reference them. They stay listed as "not configured", with no suggestion and no provisioning. Compose ships `docker/runner-classes.json`. Phase 8 replaces the file with an admin screen; the table already carries everything that screen edits.

## Core mechanisms

### Launch (web): `runs/index.post.ts`
`resolveRunTarget` and the concurrency gate stay as they are. Instead of calling `useRunManager().launch(...)`, the handler runs one transaction:
1. Insert into `runs` with `status='queued'`, `runner_class` from the body (validated; omitted means definition's class, then `is_default`), and `target_lock_key`.
2. Insert into `run_specs` with the encrypted spec. Simulated runs carry `{simulate, speed}` and no credentials; the **agent** resolves the fixture path, so a request still never names a path.
3. `NOTIFY movy_run_queued, '<class>'`.

Encrypting at enqueue keeps "the run that starts is the run that was reviewed".

### Claim (agent)
The agent wakes on `movy_run_queued` and also polls every 5 s as a fallback. It claims only while `busy < slots`:

```sql
UPDATE runs SET status = 'running', runner_id = $1, claimed_at = now(),
               started_at = coalesce(started_at, now()),
               lease_expires_at = now() + interval '30 seconds'
WHERE id = (SELECT id FROM runs
            WHERE status = 'queued' AND runner_class = $2 AND id <> ALL($3)
            ORDER BY created_at
            FOR UPDATE SKIP LOCKED LIMIT 1)
RETURNING *;
```

- A `23505` on `runs_target_busy_uq` means the destination is busy. The agent adds the id to `$3` and tries again; the run stays `queued` and the UI says why.
- After a claim, the agent decrypts `run_specs`, writes its local journal path, forks `movy-runner` with the spec on stdin, and feeds IPC into its own `EventWriter`, exactly as `RunManager.launch` does today.
- Unknown `spec_version`: the run fails with `RunnerIncompatible`, naming the versions. The agent never guesses.

### Events: agent → DB → UI
- `EventWriter` and `run-projection` move into the agent. Each flush is one transaction: `run_events` + projections + `pg_notify('movy_run_events', {runId, lastSeq})`.
- `NOTIFY` is delivered only on commit, so "broadcast after the durable write" holds by construction.
- The web hub `LISTEN`s on a **dedicated, unpooled** connection. On a notification for a room with subscribers, it reads `run_events WHERE seq > hubCursor[runId]` (cohort-filtered, as today) and publishes `WireEvent`s. The payload is a pointer because `NOTIFY` is capped at 8 KB.
- Join-before-snapshot is preserved: the hub sets the room's cursor when the first peer joins, before that peer's snapshot is read. Overlaps are dropped by `seq`; gaps can't happen.
- Several web replicas work: each one listens and fans out to its own sockets.

### Heartbeat, lease, fencing
- **Every 5 s** each agent runs one statement: update `runners.last_heartbeat_at`/`busy`, and extend `lease_expires_at = now() + 30s` on `runs WHERE runner_id = me AND status IN ('running','cancelling')`. The rows returned are the runs it still holds.
- **Fencing:** a local child whose run was *not* returned has lost its lease, and the agent SIGTERMs it at once. A runner that has been declared dead must never keep writing into a destination the ledger says is free.
- **Sweeper:** a web plugin replacing `runs-reattach.ts`, guarded by `pg_try_advisory_lock` so only one web replica sweeps. Every 10 s it:
  - marks a runner `offline` after 20 s of silence;
  - settles runs whose lease expired with `finaliseRunIfUnsettled(..., RunnerVanished)` and deletes their `run_specs`;
  - deletes expired `runner_probes`.
- **The stall report is unchanged.** A silent child of a live runner keeps its lease.
- **Agent restart:** the agent re-registers with the same stable id and runs `RunManager.reattach()` scoped to `runner_id = me`. On bare metal or in embedded mode, surviving children are followed; in a container they died with it and are settled `RunnerVanished`.
- **Graceful stop (SIGTERM):** the agent sets `state='draining'`, stops claiming runs and probes, and waits for its children up to the grace period (`MOVY_RUNNER_DRAIN_MS`, matched to the container's `stop_grace_period`). Whatever is still running at the end is killed and settled by the sweeper. Draining never cancels a run on the user's behalf.

### Cancellation
- **Queued run:** `UPDATE runs SET status='cancelled' … WHERE id=$1 AND status='queued'`. This is conditional, so it can't race a claim. If it updates 0 rows, the running path applies.
- **Running run:** `requestCancel` (existing) then `NOTIFY movy_run_cancel {runId, runnerId}`. The owning agent forwards the existing IPC cancel; as a fallback, every heartbeat re-checks for `cancelling` rows.
- `cancel.post.ts` no longer calls `useRunManager()` or reads `run.pid`.

### Queue reasons (UI)
Derived at read time, never stored:
- `no_runner`: no online runner of the class. Offers **Start a runner**.
- `runners_busy`: all slots taken. Shows the position in the class queue.
- `destination_busy`: another run holds this destination. Named only if it is in the same org; otherwise "another run is writing to this database".

### Runner availability (UI)
- Agents `NOTIFY movy_runners` only on **state changes**, not on every heartbeat. The sweeper sends it when it marks a runner offline, because a dead runner can't announce itself.
- Web keeps a per-class summary: online count, free slots, queue depth, versions.
- Pushed through a **new grant kind**: `POST /api/orgs/:slug/runners/ticket` → `SubscriptionGrant { kind: 'runners', orgId }`. "The socket performs no authorisation" still holds.
- Viewers see counts per class. Runner ids and hostnames are served to org **admins** only.

### Runner classes, size estimates and the launch form (decision 8)
- **New optional port method** on `ISchemaInspector`:
  ```ts
  /** Bytes on disk per table (data + indexes). Optional: an engine that cannot say omits it. */
  getTableSizeEstimates?(connection: IDatabaseConnection): Promise<Map<string, number>>;
  ```
  It is optional, so no existing mock or test changes. Each implementation coerces with the existing `toRowCount`-style finite-number coercion, because every driver returns `bigint` as a string:
  - **PG:** `SELECT relname, pg_total_relation_size(oid) FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace`, the same scope as `getTableRowEstimates`.
  - **MySQL:** `SELECT table_name, data_length + index_length FROM information_schema.tables WHERE table_schema = DATABASE()`.
  - **MSSQL:** `SUM(used_page_count) * 8192` from `sys.dm_db_partition_stats` joined to `sys.tables`. This needs `VIEW DATABASE STATE`; on a permission error it returns an empty map, so the preview shows "size unknown" and no suggestion rather than failing.
- **Preview wire** (`shared/definition-wire.ts`, additive):
  - `totalBytesEstimated: number | null` (null when the engine could not say);
  - per table, `bytesEstimated: number | null`;
  - `suggestedRunnerClass: string | null`: the configured class with the **highest** `suggest_above_bytes` that is ≤ the total.
- `buildPreview` takes `sizeEstimates` and `classes` as inputs and stays pure.
- `GET /api/runner-classes` returns the configured classes plus live availability.
- The definition form and the run review screen get a **Runner** selector, defaulting to the definition's class and then to `is_default`. The suggestion is a visible hint ("Source is 84 GB; the Large runner is recommended above 20 GB"), never an automatic switch.

### Provisioning ("start a runner")
```ts
interface RunnerProvisioner {
  readonly kind: 'manual' | 'docker' | 'kubernetes';
  scaleUp(runnerClass: string): Promise<ProvisionResult>;   // +1, capped by max_replicas
}
```
- **`manual`** (default): returns the command for this deployment (`docker compose up -d --scale runner-large=1`). The UI shows it with a copy button.
- **`docker`** (opt-in, `MOVY_PROVISIONER=docker`): creates a container through the Docker Engine API, cloned from the class's Compose service. It is found by the `com.docker.compose.service=runner-<class>` label, so image, env, limits and network stay identical. The new container is labelled `movy.provisioned=true` and runs with `MOVY_RUNNER_PROVISIONED_BY=docker`. It needs `/var/run/docker.sock`, which is **root on the host**, so it is enabled only through the `docker-compose.provisioner.yml` override.
- **`kubernetes`** (Phase 7): KEDA owns scaling, so enqueuing is the scale-up. The UI shows "starting a runner (cluster autoscaler)".
- **Auto mode** (`MOVY_AUTOSCALE=true`): the sweeper calls `scaleUp` when a class has queued runs, no free slots and fewer than `max_replicas` runners, with a 60 s cooldown per class.
- **Scale-down:** agents with `provisioned_by` set exit after `MOVY_RUNNER_IDLE_EXIT_MS` (default 10 min) idle, and the provisioner removes exited `movy.provisioned` containers. Baseline replicas never self-exit.
- **Permission:** a new `runner:scale` in `server/utils/rbac.ts`, granted to `admin` only.

### Test and Preview from a runner (decision 6)
- The executors move into `@movy/runner/probes`. Web handlers and agents call the same functions:
  - `testConnection(config)` → `{ ok, latencyMs, error?, errorKind? }`, the body of `connections/test.post.ts` today.
  - `inspectForPreview(source, dest, adapters)` → `{ targetDatabaseExists, sourceSchema, targetSchema, diff, plan, rowEstimates: [table, n][], sizeEstimates: [table, bytes][] }`. The maps are serialised as entries; `TableMigrationPlan` is already plain JSON.
- `buildPreview` stays in web, so the review screen can't tell the two paths apart.
- `describeConnectionFailure`/`safeErrorMessage` move with them; they depend only on `@movy/core` (verified). `server/utils/safe-error.ts` re-exports them, so the five existing callers are untouched.
- **Request flow:**
  1. The handler gets `runnerClass`.
  2. It inserts a `runner_probes` row (encrypted, `expires_at = now()+60s`) and sends `NOTIFY movy_probe`.
  3. An agent claims it with `SKIP LOCKED` into a **probe slot**, separate from run slots. It executes, writes `result`, and sends `NOTIFY movy_probe_done {id}`.
  4. The handler, awaiting that notification with a timeout (15 s test, 60 s preview), reads and deletes the row and returns **the same response shape** as in-request.
- **No runner of that class:** `503 { reason: 'no_runner', runnerClass }`, which the UI turns into the "Start a runner" offer.
- `[id]/test.post.ts` still calls `recordTest`, plus `via: 'web' | <class>`, because "works from web, fails from `large`" is the diagnosis this exists for.
- **UI:** a "from: Web ▾ / Runner: default / large" selector on Test and on the review screen. Web stays the default.

## Docker Compose

### Files
| File | Purpose |
|---|---|
| `docker/Dockerfile` | Multi-stage on `node:24-bookworm-slim`, corepack pnpm 10.33.0. Stages: `deps` (`pnpm install --frozen-lockfile`); `build` (`pnpm build`; also used by `migrate`/`seed`, because `drizzle-kit` and `tsx` are devDependencies); `runtime` (`pnpm install --prod --frozen-lockfile` + `dist/`, `apps/web/.output`, `apps/runner/fixtures`; non-root `node`, `NODE_ENV=production`; one image for web, agents and CLI); `e2e` (`FROM mcr.microsoft.com/playwright:v1.63.0-noble` + `COPY --from=build /app`; the tag must match `@playwright/test`). |
| `.dockerignore` | `node_modules`, `.nuxt`, `.output`, `dist`, `*.tsbuildinfo`, `.movy`, `logs`, `coverage`, `test-results`, `.env*`, `.git` |
| `docker-compose.yml` | The stack below |
| `docker-compose.provisioner.yml` | Opt-in override: mounts `docker.sock` into `web`, sets `MOVY_PROVISIONER=docker`, `MOVY_AUTOSCALE=true` |
| `docker/movy.env.example` + `scripts/docker-init.sh` | Generates `NUXT_SESSION_PASSWORD`, `NUXT_ENCRYPTION_KEY` (`openssl rand -base64 32`), `META_DB_PASSWORD`, `RUNNER_DB_PASSWORD`, lab passwords; sets `NUXT_ALLOW_PASSWORD_LOGIN=true`. Refuses to overwrite. (`*.env` is already gitignored; Compose doesn't use the root `.env`, which belongs to the CLI.) |
| `docker/runner-classes.json` | `default` (1 CPU / 2 GB, `max_replicas` 4) and `large` (4 CPU / 8 GB, `max_replicas` 2, `suggest_above_bytes` 20 GiB) |
| `docker/cli.env.example` | `SOURCE_POSTGRES_HOSTNAME=pg-lab`, `TARGET_MYSQL_HOSTNAME=mysql-lab`, … |
| `docker/fixtures/{postgres,mysql,mssql}/01-shop.sql` (+ `mssql/init.sh`) | One "shop" schema per engine: users, products, orders, order_items, a self-referencing FK, an enum/check, a few thousand rows, in `movy_src`, plus an empty `movy_dst`. Edge cases: a PG sequence reset **below** `MAX(id)` (step 9's reseed), MySQL AUTO_INCREMENT, MSSQL IDENTITY. One deliberately padded table (wide `text` rows) so the PG source can cross a small test threshold and the size suggestion can be seen. |
| `apps/web/scripts/seed-lab.ts` | Saves the three lab connections in `acme` with `encryptSecret(pw, secretAad(orgId, connectionId))`. Idempotent on name. |
| `docker/meta-db/10-runner-role.sh` | Phase 2: creates the `movy_runner` login role. Grants are applied by migration `0004` (see Least privilege). |

### Stack (end state, after Phase 6)

```yaml
name: movy
x-app: &app
  image: movy:local
  build: { context: ., dockerfile: docker/Dockerfile, target: runtime }
  env_file: docker/movy.env
  networks: [movy]

x-runner: &runner
  <<: *app
  init: true                       # reaps forked children; a zombie would pass a liveness check
  command: node apps/runner/dist/agent-main.js
  stop_grace_period: 2m            # = MOVY_RUNNER_DRAIN_MS: drain, never cancel
  environment: &runner-env
    MOVY_DATABASE_URL: postgres://movy_runner:${RUNNER_DB_PASSWORD}@meta-db:5432/movy_data
    MOVY_SIMULATION_FIXTURE: /app/apps/runner/fixtures/pg-to-pg-315k.ndjson
    MOVY_JOURNAL_DIR: /tmp/movy-journals   # replica-local; the DB is the record across hosts
    MOVY_RUNNER_DRAIN_MS: "110000"
  depends_on: { migrate: { condition: service_completed_successfully } }
  restart: unless-stopped

services:
  meta-db:
    image: postgres:17-alpine
    environment: { POSTGRES_USER: movy, POSTGRES_PASSWORD: ${META_DB_PASSWORD:?run pnpm docker:init}, POSTGRES_DB: movy_data, RUNNER_DB_PASSWORD: ${RUNNER_DB_PASSWORD} }
    volumes: [movy-meta:/var/lib/postgresql/data, ./docker/meta-db:/docker-entrypoint-initdb.d:ro]
    ports: ["127.0.0.1:${MOVY_META_PORT:-5442}:5432"]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U movy -d movy_data"], interval: 5s, retries: 20 }
    networks: [movy]

  migrate:                         # one-shot
    <<: *app
    build: { context: ., dockerfile: docker/Dockerfile, target: build }
    image: movy:build
    command: pnpm --filter @movy/db db:migrate
    environment: { NUXT_DATABASE_URL: postgres://movy:${META_DB_PASSWORD}@meta-db:5432/movy_data }
    depends_on: { meta-db: { condition: service_healthy } }
    restart: "no"

  seed:                            # one-shot, idempotent: dev users + lab connections
    <<: *app
    build: { context: ., dockerfile: docker/Dockerfile, target: build }
    image: movy:build
    command: sh -c "pnpm --filter @movy/web exec tsx scripts/seed-dev.ts && pnpm --filter @movy/web exec tsx scripts/seed-lab.ts"
    environment: { NUXT_DATABASE_URL: postgres://movy:${META_DB_PASSWORD}@meta-db:5432/movy_data }
    depends_on: { migrate: { condition: service_completed_successfully } }
    restart: "no"

  web:
    <<: *app
    working_dir: /app/apps/web
    command: node .output/server/index.mjs
    environment:
      HOST: 0.0.0.0
      PORT: 3000
      NUXT_DATABASE_URL: postgres://movy:${META_DB_PASSWORD}@meta-db:5432/movy_data
      MOVY_EMBEDDED_RUNNER: "false"
      MOVY_PROVISIONER: manual
      MOVY_RUNNER_CLASSES_FILE: /app/docker/runner-classes.json
    ports: ["127.0.0.1:${MOVY_WEB_PORT:-3000}:3000"]
    extra_hosts: ["host.docker.internal:host-gateway"]
    healthcheck: { test: ["CMD", "node", "-e", "fetch('http://localhost:3000/login').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"], interval: 5s, retries: 30 }
    depends_on: { migrate: { condition: service_completed_successfully } }
    restart: unless-stopped

  runner-default:
    <<: *runner
    environment: { <<: *runner-env, MOVY_RUNNER_CLASS: default, MOVY_RUNNER_SLOTS: "1" }
    deploy: { replicas: 1, resources: { limits: { cpus: "1", memory: 2g } } }

  runner-large:                    # 0 until scaled: compose --scale, the UI, or autoscale
    <<: *runner
    environment: { <<: *runner-env, MOVY_RUNNER_CLASS: large, MOVY_RUNNER_SLOTS: "1" }
    deploy: { replicas: 0, resources: { limits: { cpus: "4", memory: 8g } } }

  pg-lab:    { image: postgres:17, environment: { POSTGRES_PASSWORD: ${LAB_PG_PASSWORD} }, ports: ["127.0.0.1:5433:5432"], volumes: [./docker/fixtures/postgres:/docker-entrypoint-initdb.d:ro], healthcheck: …, networks: [movy] }
  mysql-lab: { image: mysql:8.4, environment: { MYSQL_ROOT_PASSWORD: ${LAB_MYSQL_PASSWORD} }, ports: ["127.0.0.1:3307:3306"], volumes: [./docker/fixtures/mysql:/docker-entrypoint-initdb.d:ro], healthcheck: …, networks: [movy] }
  mssql-lab:
    image: mcr.microsoft.com/mssql/server:2022-latest
    platform: linux/amd64          # no arm64 image; Rosetta on Apple Silicon
    environment: { ACCEPT_EULA: "Y", MSSQL_SA_PASSWORD: ${LAB_MSSQL_PASSWORD} }
    ports: ["127.0.0.1:1434:1433"]
    healthcheck: { test: ["CMD-SHELL", "/opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P \"$$MSSQL_SA_PASSWORD\" -Q 'SELECT 1'"], interval: 10s, retries: 30 }
    networks: [movy]
  mssql-init:
    image: mcr.microsoft.com/mssql/server:2022-latest
    platform: linux/amd64
    command: /fixtures/init.sh
    volumes: [./docker/fixtures/mssql:/fixtures:ro]
    depends_on: { mssql-lab: { condition: service_healthy } }
    restart: "no"
    networks: [movy]

  cli:                             # docker compose run --rm cli
    <<: *app
    profiles: [cli]
    env_file: docker/cli.env
    working_dir: /app
    command: node apps/cli/dist/main.js
    stdin_open: true
    tty: true
    volumes: [./logs:/app/logs]

  e2e:                             # docker compose --profile e2e run --rm e2e
    build: { context: ., dockerfile: docker/Dockerfile, target: e2e }
    profiles: [e2e]
    network_mode: service:web      # app is "localhost": the Secure session cookie works unchanged
    environment: { CI: "1", MOVY_E2E_EXTERNAL_SERVER: "1", MOVY_E2E_LIVE: "1", MOVY_E2E_COMPOSE: "1" }
    working_dir: /app/apps/web
    command: pnpm exec playwright test
    volumes: [./apps/web/test-results:/app/apps/web/test-results]
    depends_on:
      web: { condition: service_healthy }
      runner-default: { condition: service_started }
      seed: { condition: service_completed_successfully }
      mssql-init: { condition: service_completed_successfully }

networks: { movy: { name: movy-net } }
volumes:  { movy-meta: {} }
```

**Networking:**
- **Container to container:** service names on `movy-net`. In the UI a lab connection is `pg-lab:5432`, never `localhost:5433`, because Test and runs execute inside containers.
- **Host to container:** ports published on 127.0.0.1 only. The CLI on the host reaches `localhost:5433/3307/1434`; database tools reach meta-db at `localhost:5442`.
- **Container to host:** `host.docker.internal`, on `web` and the runners, for databases running outside Docker.

**Least privilege (Phase 2):** `movy_runner` gets `SELECT, INSERT, UPDATE` on `runs`, `run_events`, `run_steps`, `run_table_progress`, `runners`, `runner_probes`; `SELECT, DELETE` on `run_specs`; `SELECT` on `runner_classes`. **Nothing** on `users`, `sessions`, `memberships`, `connections` or `organizations`. If a runner is compromised, it can read run specs in flight, never the credential store at rest.

**Shortcuts** (root `package.json`): `docker:init`, `docker:up` (`docker compose --env-file docker/movy.env up -d --build`), `docker:up:provisioner` (adds the override), `docker:e2e`, `docker:cli`, `docker:scale` (`… up -d --scale runner-large=$N`).

### Why one image
Web, agents and CLI share `movy:local`, so a deploy can't leave the agent on a different `@movy/core` than the web app. Skew is still possible across rolling deploys, which `spec_version` handles.

## Code moves

> **As built in Phase 1 (2026-10-22), two deviations from this table.** The ingestion
> helpers went to `apps/runner/src/agent/ingestion.ts`, not `@movy/db/ingestion`:
> `applyProjection` takes the agent's `Projection` type, so in `@movy/db` it would have
> made the two packages depend on each other. And `crypto.test.ts` stayed in web,
> unchanged: it imports through web's re-export, so it now covers the moved code and
> the facade with no test edit. The `MOVY_ENCRYPTION_KEY` alias is deferred to Phase 2,
> the first phase with a reader for it.

| From | To | Note |
|---|---|---|
| `apps/web/server/db/schema/*`, `migrations/`, `drizzle.config.ts`, `client.ts` factory | **new `packages/db` (`@movy/db`)** | CommonJS like `@movy/core`. `apps/web/server/db/schema/index.ts` and `client.ts` re-export it, so the ~40 web imports stay put. The unscoped ingestion helpers (`applyProjection`, `finaliseRunIfUnsettled`, `findUnsettledRuns`, `markRunLaunched`) move to `@movy/db/ingestion`; the org-scoped repo stays in web. `db:migrate` moves to `@movy/db`; web's script delegates. |
| `apps/web/server/utils/crypto.ts` (`encryptSecret`, `decryptSecret`, `secretAad`, key loading) | `@movy/db/crypto` | Agents decrypt `run_specs`/probes. Reads `MOVY_ENCRYPTION_KEY ?? NUXT_ENCRYPTION_KEY`. Web's file re-exports it. `hashLocalPassword` stays in web. |
| `server/runs/{event-writer,run-projection,journal-tailer,run-manager}.ts` | `apps/runner/src/agent/` | Imports verified portable (`@movy/core`, `@movy/runner/protocol`, `RunStatus`). |
| connection-test body, preview inspection, `safe-error.ts` core | `apps/runner/src/probes/` | Handlers become thin. |
| — | `apps/runner/src/agent/{agent,claim,heartbeat,probe-worker}.ts`, `src/agent-main.ts` | New `movy-runner-agent` bin; per-run `main.ts` untouched. |
| `server/plugins/runs-reattach.ts` | `server/plugins/{runner-sweeper,embedded-runner,runner-classes}.ts` | |
| `server/runs/index.ts` `useRunManager`/`useEventWriter` | removed from web | `useRunHub` gains the `LISTEN` feed. `journalPathFor`, `simulationFixture` and `resolveRunnerEntry` move to the agent. |

Nitro externals gain `@movy/db` and `@movy/runner`.

## Phases

Each phase leaves `pnpm test`, `pnpm typecheck` and the existing e2e green.

0. **Compose foundations** (useful before any runner change, and the test bed for every later phase):
   - Dockerfile, `.dockerignore`, `docker-compose.yml` with `meta-db`, `migrate`, `seed`, `web`, the lab DBs, `mssql-init`, `cli`, `e2e`; init script; fixtures; `seed-lab.ts`.
   - The `playwright.config.ts` guard: `webServer: process.env.MOVY_E2E_EXTERNAL_SERVER ? undefined : {…}`.
   - `live-migration.spec.ts`: a real PG→PG run against the lab (PG→MySQL as `test.fixme`, see the auto-increment gap), skipped unless `MOVY_E2E_LIVE` is set.
   - The web container still **forks** the runner as today, so this phase sets `MOVY_RUNNER_ENTRY=/app/apps/runner/dist/main.js`, `MOVY_JOURNAL_DIR` on a `movy-journals` volume, and `init: true` on `web`. Phase 6 removes all three.
   - *Gate:* `pnpm docker:up` gives all services healthy or exited 0; `pnpm docker:e2e` is green; `docker compose run --rm cli` completes MySQL→PG.
1. **Extract, no behaviour change.** `@movy/db` (+ crypto), run-control modules into `apps/runner/src/agent`, web imports repointed; web still forks.
   *Gate:* all existing tests pass after moving their files only; Phase 0's `pnpm docker:e2e` is still green.
2. **Queue and agent.**
   - Migration `0004` and the runner role/grants.
   - The agent: claim, heartbeat, lease, fencing, drain; the sweeper; embedded mode; the queued-cancel path.
   - Web stops forking; the launch handler enqueues.
   - *Gate:* `run-lifecycle.spec.ts` green with `MOVY_EMBEDDED_RUNNER=true`.
3. **NOTIFY bus.** The hub feeds from `LISTEN` (the `onFlushed` path is removed); runner availability grant, room and panel (org home, runs page).
4. **Destination lock and classes.**
   - The lock index; queue reasons.
   - `runner_classes` file upsert and API; `definitions.runner_class`; selector on the definition and review screens.
   - `getTableSizeEstimates` for PG/MySQL/MSSQL; preview bytes and suggestion.
   - *As built (2026-10-23), four deviations.* (1) The lock is a separate migration
     (`0005`) and the class columns another (`0006`), which also adds
     `runner_classes.configured`: "not configured" needed a column, and such a class is
     hidden from the panel and selector rather than listed. (2) The claim skips a busy
     destination in its own `WHERE` (`NOT EXISTS`) and the unique index is the backstop
     for two claims at once; a refused claim simply asks again, since the winner has
     committed by then. (3) There is no `GET /api/runner-classes`: the selector reads the
     runners snapshot it already had, so a class choice shows that class's availability.
     (4) MSSQL sizes come from `sys.allocation_units`, which needs no
     `VIEW DATABASE STATE`. The wire field is `runnerSuggestion {runnerClass, label,
     aboveBytes}` rather than a bare class name, so the hint can say the threshold.
5. **Probes.** Test and Preview from a runner; `via` on the last test; UI selectors.
6. **Runner services and provisioning in Compose.**
   - `web` loses `MOVY_RUNNER_ENTRY`, `MOVY_JOURNAL_DIR`, `init: true` and the journals volume.
   - Add `runner-default`/`runner-large` (stack above) and `docker-compose.provisioner.yml`.
   - `manual` and `docker` provisioners, auto mode, idle exit, `runner:scale`.
   - New compose-only e2e specs (below).
   - *Gate:* the Verification list below.
7. **Kubernetes** (later):
   - A Deployment per class with requests/limits, from the same image.
   - KEDA `ScaledObject` per class, PostgreSQL trigger `SELECT count(*) FROM runs WHERE runner_class='large' AND status IN ('queued','running')`, `minReplicaCount: 0` for `large`.
   - `terminationGracePeriodSeconds` = drain.
   - Agents set the `controller.kubernetes.io/pod-deletion-cost` annotation high while busy, so a scale-down evicts idle pods first. The alternative is KEDA `ScaledJob` for `large`.
   - Subscription tickets move to the DB, or sticky sessions, because `TicketStore` is per process.
   - A Helm chart or kustomize.
8. **Next phase: runner classes in the UI.**
   - An admin screen to create and edit classes (label, description, resources, `max_replicas`, `suggest_above_bytes`, default).
   - The boot-time file becomes a seed only: applied when the table is empty, never overwriting UI edits.
   - Resource changes on a class apply to **new** replicas. The screen says so, and in Compose it shows the command to recreate the service.

## Verification (end of Phase 6, in Compose)
1. `pnpm docker:init && pnpm docker:up`: `docker compose ps` shows every service healthy or exited 0. `http://localhost:3000` → sign in as `admin@movy.local` / `movy-dev` → the three lab connections are listed and Test passes on each.
2. The org home shows "Default: 1 online, 1 free; Large: 0 online". `docker compose stop runner-default`: within about 20 s it shows "Default: 0 online".
3. Launch with no default runner: the run shows `queued: no runner` and **Start a runner** (admin only). With the provisioner override, press it: a container appears, claims the run, and the timeline goes live. Without it, the copyable command is shown.
4. Two runs into the same `movy_dst` from different orgs: the second shows `queued: destination busy` until the first settles, then runs.
5. `docker compose restart web` mid-run: the run continues; the reloaded page catches up from the same `seq` with no gap and no duplicate.
6. `docker compose kill runner-default` mid-run: within about 30 s the run is `failed` / `RunnerVanished`, says "may be partially applied", and is **not** retried.
7. `docker network disconnect movy-net <runner>` for over 30 s, then reconnect: the runner fences, its child is gone, and the run is settled. No writes reach `movy_dst` after the settle (check row counts).
8. `docker compose stop runner-default` mid-run: the runner drains for up to 2 minutes; a short simulated run finishes `succeeded`.
9. Preview a definition on the padded PG source with the test class threshold: it shows total bytes and suggests `large`. The run launches on `large` once it is scaled.
10. Test a lab connection "from: large" with 0 replicas: 503 → Start a runner → retry succeeds; the connection shows `via: large`. A preview "from runner" equals a preview "from web" (JSON diff empty apart from `takenAt`).
11. A viewer sees class counts but no runner ids. A run socket for another org is still refused.
12. `docker compose down && pnpm docker:up`: users, definitions and runs survive; `down -v` resets everything.
13. `pnpm docker:e2e` green. `pnpm test` and a host `pnpm test:e2e` (embedded runner) green.

## Risks
- **`LISTEN` and connection poolers:** PgBouncer in transaction mode drops `LISTEN`. The hub and agents use a dedicated direct connection.
- **Clock skew:** leases use the database's `now()` everywhere.
- **Probe latency:** one round trip through the DB (about 50–200 ms); the web path stays the default.
- **Docker provisioner = root on the host:** an opt-in override only, called out in docs and `.env.example`.
- **SQL Server on Apple Silicon:** needs Rosetta and about 2 GB of RAM; Azure SQL Edge is retired.
- **Version skew in rolling deploys:** `spec_version` + `RunnerIncompatible`.
- **Size estimates are statistics,** not exact (`pg_total_relation_size` is exact on disk but includes bloat; MySQL's `data_length` is an InnoDB estimate). They are good enough for a suggestion, which is all they drive.
- **Kubernetes scale-down killing a busy pod:** handled by pod-deletion-cost or `ScaledJob` (Phase 7).
- **Phase 1 is a wide, mechanical diff;** the re-export shims keep it reviewable.
- **Not a production deploy as-is:** password login and known seeded passwords are on in Compose. A production override (no seed, no lab, Google SSO, TLS proxy) is out of scope.

### Plan Verification
- **Depth:** checks done inline, without sub-agents. Read directly: `server/runs/*`, `runs/index.post.ts`, `cancel.post.ts`, `runs/preview.post.ts`, `connections/test.post.ts`, `runs-reattach.ts`, `runs.ts` schema, `runs.repo.ts`, `rbac.ts`, `crypto.ts`, `safe-error.ts`, `definition-wire.ts`, `pg-schema-inspector.adapter.ts`, `playwright.config.ts`, `nuxt.config.ts`, `seed-dev.ts`.
- **Completeness:** gaps found and fixed:
  - queued-run cancel; fencing; dead-runner offline notification; the 8 KB `NOTIFY` cap; `Map` serialisation; simulated fixture path resolved on the agent; the cross-replica sweep race; spec version skew; `TicketStore` under several web replicas;
  - **crypto must move** (agents decrypt specs);
  - graceful drain on SIGTERM;
  - MSSQL size query needs `VIEW DATABASE STATE` (degrades to "unknown");
  - a class removed from the config file can't be deleted (referenced);
  - the Secure cookie in e2e (`network_mode: service:web`); `--env-file` failing in containers; `drizzle-kit` dev-only; Playwright `webServer` vs an external server; SQL Server has no init directory.
- **Blast radius:**
  - Consumers of `useRunManager`/`useEventWriter`: `runs/index.post.ts`, `runs/[id]/cancel.post.ts`, `plugins/runs-reattach.ts`, `server/runs/index.ts`. All in the plan.
  - Consumers of `journal_path`/`pid`: `runs.repo.ts`, `run-manager.ts`, `journal-tailer.ts`, `subscription-ticket.ts`; the nullable column is checked in Phase 2.
  - `safe-error` and `crypto` callers are unchanged via re-exports.
  - `ISchemaInspector` gains an **optional** method, so the 8 test files using `getTableRowEstimates` mocks are unaffected.
  - The preview wire change is additive.
  - Unintended impact: none known. `run_events`' key, `shared/run-wire.ts` and the runner child contract are untouched.
- **Standards:**
  - Sources: CLAUDE.md (module tables, socket authorisation, broadcast-after-write, "events describe progress, never configuration", "an engine that cannot list is assumed to have it"), ADR 0002, the user rules.
  - Reuses `encryptSecret`, `finaliseRunIfUnsettled`, `RunManager.reattach`, `describeConnectionFailure`, `SubscriptionGrant`, row-estimate coercion, and the optional-capability pattern of `adapters.listDatabases`.
  - Stays CommonJS.
  - Deviation: `target_lock_key` stores a hash derived from the host, never serialised.
- **Docs and help to update:**
  - ADR 0004 (draft written).
  - `CLAUDE.md`: Commands, "Run events", "Runs in the web app" table, "The live stream" (`onFlushed` → `NOTIFY`), "The runner", "End-to-end tests".
  - `README.md`: new "Running with Docker"; "The web console", "Requirements", "Tests".
  - `apps/runner/README.md` (agent mode, env); `apps/web/.env.example` (`MOVY_EMBEDDED_RUNNER`, `MOVY_PROVISIONER`, `MOVY_AUTOSCALE`, `MOVY_RUNNER_CLASSES_FILE`); `packages/core/tests/integration/README.md` (point to the lab services); `docs/web-ui-progress.md`.
  - UI copy: queue reasons, "Start a runner", the 503 sentence, the class selector and size suggestion, "size unknown".
- **Tests:**
  - **Moved, import paths only:** `event-writer`, `event-cap`, `journal-tailer`, `run-manager`, `run-projection` (to `apps/runner/tests/unit/agent/`); `crypto.test.ts` (to `packages/db/tests/`).
  - **Untouched and must stay green:** `apps/runner/tests/process/*`, `run-reducer`, `step-order`, `run-serializer`, `pair-capability`, all core inspector tests.
  - **Intentionally updated:**
    - `socket-isolation.test.ts`: input moves from `onFlushed` to the `LISTEN` feed; it still runs real hub output through the real reducer, and gains a viewer-on-`runners` case.
    - `build-preview.test.ts`: new cases for bytes, unknown size and suggestion choice; the existing assertions are kept.
    - `playwright.config.ts`: guard only.
  - **New (unit, mocks):**
    - agent claim/heartbeat/fencing/drain against an injected queue port; sweeper; queue reasons; provisioner cap and cooldown; probe round trip; `specAad` binding; class-file validation;
    - `getTableSizeEstimates` for each of the three inspectors, including string-bigint coercion and the MSSQL permission fallback.
  - **New (PGlite, decision 7):** claim order, unique-index skip, lease expiry settle, the queued-cancel vs claim race, NOTIFY-on-commit-only. True multi-connection `SKIP LOCKED` concurrency goes in a non-automated integration test against Compose's meta-db.
  - **New e2e:**
    - `live-migration.spec.ts` (Phase 0);
    - `runner-availability.spec.ts` and `queue-and-scale.spec.ts` (Phase 6, `MOVY_E2E_COMPOSE`, the latter also needs the provisioner override);
    - `web-restart.spec.ts` (Phase 6: restart `web` mid-run through the Docker API from the e2e container, which needs the provisioner override's socket; otherwise manual step 5).
  - No tests weakened.
- **Open questions:** none blocking. Phase 8 scope is agreed as "next phase".

## TLDR: why these changes
- Runners must scale separately from the UI, and the UI must survive restarts during a run. Forking from the web process prevents both.
- Postgres already holds the run ledger, so making it the queue too means one source of truth, no new service, and "notify only after commit" for free.
- Keeping the per-run child unchanged keeps every proven safety property: redaction, journal-first, exit codes, no resume.
- Leases plus fencing replace pid checks, because pids mean nothing across machines.
- The destination lock stops two runs from clearing each other's tables, which the per-org limit can't do across orgs.
- Bytes predict how heavy a run is better than rows, which is what choosing a runner class is about.
- Compose comes first because every later phase needs real databases and a meta-db to prove itself. Its runner pools are the same shape Kubernetes will run.
