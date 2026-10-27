# Plan: runner phase R7 — Kubernetes

*Drafted 2026-10-27 for [#11](https://github.com/EduardoPetrini/nodejs-movy-data/issues/11). Phase 7 of `docs/runner-service-plan.md`. The stream-ticket item of that phase is already done (`docs/stream-tickets-plan.md`, PR #23).*

## TLDR
- Movy gets a **Helm chart** (`deploy/helm/movy`) that installs the console, the runners, migrations and, optionally, the meta-db and the three lab databases.
- **`default` runners stay a Deployment.** They stay warm, answer Test/Preview probes, and take the small runs.
- **`large` runners become Kubernetes Jobs.** KEDA starts one Job per queued run. The Job's agent claims one run, finishes it and exits, so nothing large stays up idle.
- **A new `kubernetes` provisioner** backs "Start a runner". For a Job class it says the cluster is starting one. For a Deployment class it adds one replica through the Kubernetes API.
- The code needs six small changes: `tini` in the image, a "one run, then exit" agent mode, a health check, a `runner_demand` view plus a read-only `movy_scaler` role for KEDA, the provisioner, and UI wording for on-demand classes.
- Proof: a `kind` cluster runs `live-migration.spec.ts` (including SQL Server), scales `large` from 0 to 1 and back, survives a rolling restart of `web`, and never kills a busy runner.
- **Agent health:** an opt-in HTTP port (`/livez`, `/readyz`) whose liveness never reads the meta-db (decided 2026-10-27, option B).

---

## Decisions

| # | Question | Decision | Notes |
|---|---|---|---|
| 1 | Protecting a busy pod on scale-down | **KEDA `ScaledJob` for on-demand classes (`large`)**; `default` stays a Deployment | Agreed, with the caveats below |
| 2 | Packaging | **Helm**, one chart | Agreed. The complexity stays in `values.yaml`, not in templates per environment |
| 3 | "Start a runner" on Kubernetes | **A `kubernetes` provisioner** | See step 5 |
| 4 | Agent health check | **Opt-in HTTP port** (`MOVY_RUNNER_HEALTH_PORT`), option B | Decided 2026-10-27; see *Decision 4* |
| 5 | SQL Server in the kind lab | **Included** | Needs about 2 GB RAM and Rosetta on Apple Silicon, same as Compose |

### My view on decision 1 (Jobs for `large`)
I agree. It is the better fit for this codebase, not just a cheaper one:
- **No resume means one run per pod costs nothing.** A Job pod that dies takes its run with it. That is already what happens to a dead runner (`RunnerVanished`, never retried).
- **KEDA never scales a running Job down.** The "scale-down kills a busy pod" risk goes away for `large` without any code. `pod-deletion-cost` would have needed a ServiceAccount, RBAC and a Kubernetes client inside every runner.
- **Resources come back when the run ends.** On a cluster autoscaler that also means the big node goes away.

The costs, and how the plan handles each:
- **Cold start.** Scheduling, pulling the image and registering take roughly 10–60 s before a large run starts. That's acceptable for a run big enough to need `large`. The run page shows "starting a runner", not "no runner".
- **Probes "from large".** A Test that waits 15 s cannot wait for a cold pod. KEDA also counts queued probes (step 3), and a Job agent waits `MOVY_RUNNER_JOB_IDLE_MS` (120 s) before it exits when idle. So the first Test returns 503 or 504 with "a runner is starting, try again", and a retry within two minutes reaches the warm pod. Testing from `default` is unaffected.
- **A wasted pod now and then.** Two Jobs can race for one run. The loser finds nothing, waits 120 s and exits. That's bounded, and it costs no correctness.
- **Node drain.** `kubectl drain` still evicts a Job pod, and its run settles as `RunnerVanished`. The pod carries `cluster-autoscaler.kubernetes.io/safe-to-evict: "false"`, so the autoscaler at least never chooses that node. The docs say what a manual drain does.
- **`runners` rows.** Each Job registers under its own pod name. Offline runners are already deleted after a day (`sweep()` in `queue-store.ts`), so the table stays bounded.

`default` is **not** autoscaled by KEDA in this phase. Its replica count comes from values, and "Start a runner" can add one (step 5). Autoscaling a Deployment brings back the busy-pod problem that the Job design avoids. If it's ever needed, it is a follow-up with `pod-deletion-cost`, recorded in the ADR.

### Decision 4: how the agent reports its health

The agent listens on no port today, and Compose has no health check for it. On Kubernetes the kubelet needs a signal. One rule settles most of the design: **liveness must not depend on the meta-db.** If it did, a meta-db outage would fail every runner's liveness check at once. The kubelet would restart them all and kill every live run. Fencing already handles losing the database, so liveness should only answer "is this process still working?".

| Option | How | Pros | Cons |
|---|---|---|---|
| **A. Heartbeat file + exec probe** | The agent's 1 s lease-check timer touches `/tmp/movy-agent-alive`. The probe runs a check on the file's age. | No port, so it keeps the "listens on nothing" property. Works the same in Compose. | Exec probes fork a process every period. `find -newermt` is brittle and `node -e` costs ~40 MB and ~100 ms each time. Mtime checks depend on clock behaviour. |
| **B. Opt-in HTTP port** (`MOVY_RUNNER_HEALTH_PORT`) | A `node:http` server answers `GET /livez` (event loop and timers ticking) and `GET /readyz` (registered, not draining). Unset in Compose, so nothing listens there. | `httpGet` is the kubelet's native probe: no forked process. Readiness means something, because a draining pod reports not ready. The same port could serve `/metrics` later. | A listening port is new attack surface. It answers only two fixed strings with no data, and a NetworkPolicy allows only the kubelet. It also needs care not to share the event loop it is checking (see the timer rule below). |
| **C. No liveness probe** | Rely on process exit and `restartPolicy`. | No code. | A wedged agent stays wedged. The R6 partition bug had exactly that shape: alive, heartbeating, never claiming. |

**Decided (2026-10-27): B.** `/livez` reports healthy only while the lease-check timer fired within the last 10 s. That timer is the agent's own clock, so the check doesn't touch the database and still catches a blocked event loop. `/readyz` is false while draining. Exec probes on every pod of every class cost more over time than one small handler, and A's main advantage (no port) still holds in Compose because the port is opt-in.

A and C were rejected for the reasons in the table. The decision is recorded in ADR 0004's Amendment 2 alongside decision 1.

---

## Step 1 — The image runs under `tini` (gap 1)

- **`docker/Dockerfile`, `runtime` stage:** `apt-get install -y --no-install-recommends tini`, then `ENTRYPOINT ["/usr/bin/tini", "--"]`.
- **No `-g`.** tini forwards a signal to its direct child only, which is the agent. The runners the agent forks are detached on purpose, and a forwarded SIGTERM would reach them as a user's cancel. Kubernetes sends SIGTERM to PID 1 only, so this keeps today's drain behaviour.
- **`docker-compose.yml`:** remove `init: true` from `x-runner`, because the image now provides it. Keep the comment explaining why an init process is needed, and move it to the Dockerfile.
- The `e2e` and `build` targets are unchanged.

## Step 2 — Agent: Job mode and health (gaps 2, 3)

In **`apps/runner/src/agent/agent-config.ts`** (parsed strictly, exit 64 on a bad value, as today):

| Env | Default | Meaning |
|---|---|---|
| `MOVY_RUNNER_MAX_RUNS` | unset (unlimited) | Stop claiming after this many claims. Exit 0 once those runs have settled. |
| `MOVY_RUNNER_HEALTH_PORT` | unset | Serves `/livez` and `/readyz` when set (Decision 4) |

- **Job mode** is `MOVY_RUNNER_MAX_RUNS=1` together with `MOVY_RUNNER_PROVISIONED_BY=kubernetes-job` and `MOVY_RUNNER_IDLE_EXIT_MS=120000`. Each piece already exists or is one option. There is no separate "mode" flag that could disagree with them.
- **`RunnerAgent`** (`runner-agent.ts`) gains an optional `maxRuns`. It counts successful claims in `claimLoop`. When the count reaches `maxRuns` it calls the existing `stopClaiming()` and exposes `exhausted`.
- **`agent-main.ts`:** the idle interval also exits through `shutdown('done', 0)` when `exhausted` is true and nothing is busy. `IdleWatch` is reused as is.
- **Deployment pods** leave `MOVY_RUNNER_PROVISIONED_BY` unset. Today that already means "never idle-exit", which is required there: the Deployment would restart a pod that exits (gap 3). The Helm template sets it **only** on Job pods, and the chart's test (step 8) asserts that.
- **Health:** a new `apps/runner/src/agent/health-server.ts`, about 40 lines on `node:http`. It takes two functions, `alive()` and `ready()`, so it can be tested without an agent. The lease-check timer in `runner-agent.ts` records `lastTickAt`. `alive` means `now - lastTickAt < 10_000`, and `ready` means started and not draining. The server binds `0.0.0.0` and is closed during `shutdown`.

## Step 3 — What KEDA reads: a `runner_demand` view and a `movy_scaler` role (gaps 5, 6)

- **Migration `0011_runner_demand.sql`** (generated, then read before it's applied, as CLAUDE.md requires):
  ```sql
  CREATE VIEW runner_demand AS
  SELECT c.name AS runner_class,
         (SELECT count(*) FROM runs q
           WHERE q.status = 'queued' AND q.runner_class = c.name
             AND (q.target_lock_key IS NULL OR NOT EXISTS (
                   SELECT 1 FROM runs b WHERE b.target_lock_key = q.target_lock_key
                      AND b.status IN ('running', 'cancelling'))))::int AS claimable_runs,
         (SELECT count(*) FROM runner_probes p
           WHERE p.runner_class = c.name AND p.status = 'queued'
             AND p.expires_at > now())::int AS queued_probes
    FROM runner_classes c WHERE c.configured;
  ```
  - A run waiting only on its destination is not demand: another runner would wait on the same lock. Auto mode already applies that rule, and the view is now its only copy.
  - `apps/web/server/runners/autoscale.ts` `loadClassDemand` reads `claimable_runs` from the view instead of its inline subquery, so Compose's auto mode and KEDA cannot disagree about what demand means.
  - The view exposes a class name and two counts, never an org, a run id or a destination. It runs with its owner's rights (the default, `security_invoker` off), so the reading role needs no grant on `runs`.
  - `ProbeStatus` is `'queued' | 'running' | 'done'` (`packages/db/src/schema/runners.ts:67`), so `status = 'queued'` is unclaimed work.
- **KEDA trigger, per Job class:** `SELECT claimable_runs + queued_probes FROM runner_demand WHERE runner_class = 'large'`, with `targetQueryValue: 1`, `scalingStrategy: accurate` (the count excludes claimed work), `maxReplicaCount` = the class's `max_replicas`, and `pollingInterval: 10`. Verify the strategy's arithmetic in kind (step 9) before relying on it.
- **`packages/db/src/runner-role.ts`:** add `SCALER_ROLE = 'movy_scaler'` and `ensureScalerRole(sql, password)`, shaped like `ensureRunnerRole`: `REVOKE ALL`, `USAGE` on the schema, and `SELECT` on `runner_demand` only.
  - `scripts/runner-role.ts` also runs it when `SCALER_DB_PASSWORD` is set. Like the runner role, it is skipped with a log line otherwise. Compose doesn't set it.
  - `RUNNER_GRANTS` is unchanged, and `movy_runner` gets nothing on the view.

## Step 4 — The `kubernetes` provisioner (gap 4, decision 3)

New files in `apps/web/server/runners/`:
- **`kube-api.ts`:** the few calls it makes, with no client library, for the same reason `docker-engine.ts` gives. It uses the in-cluster ServiceAccount token and CA (`/var/run/secrets/kubernetes.io/serviceaccount/`) and `KUBERNETES_SERVICE_HOST`/`_PORT`. Calls:
  - `getScale(deployment)` and `patchScale(deployment, replicas)` on `apps/v1 …/deployments/{name}/scale`;
  - `countActiveJobs(runnerClass)`: list `batch/v1` jobs by label `movy.runner-class=<class>`, active only.
- **`kubernetes-provisioner.ts`:** `kind = 'kubernetes'`. The classes come from `MOVY_K8S_JOB_CLASSES` (comma-separated, checked with `isRunnerClassName`) and `MOVY_K8S_DEPLOYMENT_PREFIX` (default `movy-runner-`); Helm sets both from values.
  - **A Job class** returns `{ status: 'on_demand', runnerClass, starting }`, where `starting` is the number of active Jobs. It creates nothing, because enqueuing is the scale-up (KEDA).
  - **A Deployment class** reads the scale, returns `at_capacity` at `max_replicas`, and otherwise patches `replicas = current + 1`. Two console replicas pressing at once both write the same number, so this path cannot overshoot the cap the way #10 does with Docker.
  - `cleanup()` returns 0: Jobs carry `ttlSecondsAfterFinished`.
  - An API error is a `ProvisionerError` with a safe message (no token, no URL), surfaced as today's docker errors are.
- **`provisioner.ts`:** `ProvisionerKind` gains `'kubernetes'`. **`use-provisioner.ts`:** `MOVY_PROVISIONER=kubernetes` builds it.
- **Auto mode** is meaningless here: KEDA owns Job classes, and nothing would ever scale a Deployment back down. `use-provisioner.ts` logs a warning and ignores `MOVY_AUTOSCALE=true` with the kubernetes provisioner. That is refused with a reason, never applied silently.

## Step 5 — The UI says "on demand" (gap 4)

- **`shared/runner-wire.ts`:** `ScaleResult` gains `{ status: 'on_demand'; runnerClass; starting: number }`, and `scaleSentence` covers it: "The {label} class starts a runner for each queued run. {n} starting now."
- **`shared/queue-wire.ts`:** `QueueFacts` gains `onDemand: boolean`. With no runner online, an on-demand class gives the new reason `'scheduling'` instead of `'no_runner'`. Its sentence is "Starting a {label} runner: the cluster starts one for each queued run, usually within a minute."
  - `server/runs/queue-state.ts` fills `onDemand` from the provisioner (`isOnDemand(class)`, false for `manual` and `docker`).
  - The runner summary carries the same flag, so the panel says "on demand" instead of "0 online" for such a class.
- **`StartRunner.vue`** is absent for `scheduling`, as it is today for any reason other than `no_runner`. The probe 503 sentence for an on-demand class says to retry in a minute.
- No other surface changes. Compose keeps every current sentence, because `onDemand` is false there.

## Step 6 — The Helm chart (`deploy/helm/movy`)

```
deploy/helm/movy/
├── Chart.yaml                  # appVersion = the image tag
├── values.yaml                 # documented; production-shaped defaults
├── values-kind.yaml            # bundled meta-db, lab on, seed on, small resources
├── files/fixtures/             # copied from docker/fixtures by pnpm k8s:sync-fixtures
└── templates/
    ├── _helpers.tpl
    ├── secrets.yaml            # movy, runner, scaler, meta-db, lab: see "Secrets"
    ├── migrate-job.yaml        # pre-install/pre-upgrade hook, image target `build`
    ├── seed-job.yaml           # post-install, only when seed.enabled
    ├── web-deployment.yaml     # replicas: 2, readiness on /api/health*
    ├── web-service.yaml
    ├── web-rbac.yaml           # only when provisioner.kind = kubernetes
    ├── runner-deployment.yaml  # range over classes with mode: deployment
    ├── runner-scaledjob.yaml   # range over classes with mode: job (needs KEDA)
    ├── scaler-auth.yaml        # KEDA TriggerAuthentication from the scaler secret
    ├── runner-classes-cm.yaml  # MOVY_RUNNER_CLASSES_FILE, rendered from values
    ├── networkpolicy.yaml      # runner health port: kubelet only
    ├── meta-db.yaml            # StatefulSet + Service, only when metaDb.bundled
    └── lab/                    # pg/mysql/mssql + mssql-init Job, only when lab.enabled
```

- **One list of classes** in values drives the Deployments, the ScaledJobs, the runner-classes ConfigMap and `MOVY_K8S_JOB_CLASSES`:
  ```yaml
  runnerClasses:
    - { name: default, label: Default, mode: deployment, replicas: 1, slots: 2,
        resources: { cpu: "1", memory: 1Gi }, maxReplicas: 3, default: true }
    - { name: large, label: Large, mode: job, slots: 1,
        resources: { cpu: "4", memory: 8Gi }, maxReplicas: 2, suggestAboveBytes: 21474836480 }
  ```
  The class file and the pods cannot drift, because they come from one source. Phase 8 makes the class table editable; this list then becomes its seed, which matches the R8 plan.
- **Runner pods** get `runner.env`'s equivalents only: the `movy_runner` URL and the encryption key. They never get the owner password or the session secret (CLAUDE.md, Compose rules).
  - Journals go on an `emptyDir`. `terminationGracePeriodSeconds: 120` = the drain (`MOVY_RUNNER_DRAIN_MS: 110000`).
  - **Job pods:** `restartPolicy: Never`, `backoffLimit: 0` (no retries, ever), no `activeDeadlineSeconds` (runs can be long), `ttlSecondsAfterFinished: 600`, and the `safe-to-evict: "false"` annotation.
- **Web:** `MOVY_EMBEDDED_RUNNER=false`, `MOVY_PROVISIONER=kubernetes`, 2 replicas (proven by `stream_tickets`), and a ServiceAccount with a namespaced Role. The Role allows `get`/`patch` on `deployments/scale` (resourceNames = the runner Deployments) and `list` on `jobs`. Nothing else.
- **`LISTEN` needs a direct connection.** `values.yaml` documents that `metaDb.url` must not point at a transaction-mode PgBouncer.
- **Secrets:** the encryption key must never be regenerated, because that makes every saved connection undecryptable. The chart uses `existingSecret` or, when it generates a value, keeps it across upgrades with `lookup`. A test renders an upgrade and asserts the key is unchanged. This is the Helm equivalent of `docker:init` refusing to overwrite.
- **Migrations** run the `build` image (drizzle-kit and tsx are devDependencies), as Compose's `migrate` does, with the same command plus `SCALER_DB_PASSWORD`. That means two images per release, and both are tagged from `Chart.appVersion`.
- **Fixtures:** `docker/fixtures/*` (tiny) are copied into `files/fixtures/` by `scripts/k8s-sync-fixtures.sh` (`pnpm k8s:sync-fixtures`), because Helm cannot read files outside the chart. A unit test fails if the copies drift.
- **Lab hostnames:** the lab Services are named `pg-lab`, `mysql-lab` and `mssql-lab`, so `seed-lab.ts` and the connections it saves work unchanged.

\* `/api/health` exists (`server/api/health.get.ts`) and returns `{ ok: true }` without touching the database. That is right for liveness. Readiness uses it too: the meta-db being down should not take every web pod out of the Service.

## Step 7 — Scripts

| Script | Does |
|---|---|
| `pnpm k8s:up` | `kind create cluster` (config in `deploy/kind/cluster.yaml`), install KEDA, `docker build` both targets, `kind load`, `helm upgrade --install -f values-kind.yaml`, wait for rollout |
| `pnpm k8s:e2e` | `kubectl port-forward svc/movy-web 3000` and run host Playwright with `MOVY_E2E_EXTERNAL_SERVER=1 MOVY_E2E_LIVE=1 MOVY_E2E_K8S=1` |
| `pnpm k8s:down` | `kind delete cluster` |

The port-forward makes the console `localhost` to the browser, so the `Secure` cookie works, which is the same reason Compose's e2e uses `network_mode: service:web`. **Prerequisites** (none are installed today, only `kubectl`): `kind`, `helm`, and the KEDA chart repo. The README lists them.

## Step 8 — Tests

**Unit (`pnpm test`, no cluster):**
- `agent-config.test.ts`: `MAX_RUNS` and `HEALTH_PORT` parsing, including bad values → exit 64.
- `runner-agent.test.ts`: stops claiming after `maxRuns`, `exhausted` only once runs settle, and a run settled while exhausted leads to exit.
- `health-server.test.ts`: `/livez` 200 → 503 when ticks stop, `/readyz` false while draining, 404 elsewhere, and the response contains no data.
- `kubernetes-provisioner.test.ts`: against a fake `KubeApi`. Covers the Job class → `on_demand` with a count, the Deployment class → patch +1, the cap → `at_capacity`, and an API error → safe message with no token.
- `use-provisioner.test.ts`: `kubernetes` plus `MOVY_AUTOSCALE` → warned and ignored.
- `queue-state.test.ts` / `runner-wire.test.ts`: the `scheduling` reason and its sentence, and the `on_demand` sentence. Existing cases are unchanged.
- **PGlite with real migrations:**
  - `runner-demand.test.ts`: destination-blocked runs excluded, expired probes excluded, unconfigured classes absent;
  - `runner-role.test.ts` gains `movy_scaler`: it can read `runner_demand` and is refused `runs`, `connections` and every other table;
  - `autoscale` demand still matches its existing expectations through the view.
- `helm-chart.test.ts`: runs `helm template` and is skipped when `helm` is absent, like the e2e gates. It asserts:
  - Job pods have `backoffLimit: 0` and `restartPolicy: Never`;
  - only Job pods set `MOVY_RUNNER_PROVISIONED_BY`;
  - no runner pod references the movy secret;
  - the web Role grants only the listed verbs;
  - the encryption key survives a re-render;
  - the fixtures match `docker/fixtures`.

**Live (kind), the "Done when" list from #11:**
1. `live-migration.spec.ts` green, PG→PG, MySQL→PG, PG→MySQL, PG→MSSQL and MySQL→MSSQL, with no change to the spec beyond the `MOVY_E2E_K8S` URL plumbing.
2. `k8s-scaling.spec.ts` (new, gated on `MOVY_E2E_K8S`): launch on `large` → the page reads "Starting a Large runner" → a Job appears → the run succeeds → the Job completes → after `ttl` there are 0 large pods. It uses `kubectl` from the host via `child_process`, the access Compose's e2e container never had (#19).
3. **Rolling restart:** start a simulated run and run `kubectl rollout restart deployment/movy-web` while it's going. The page catches up from the same `seq` with no gap and no duplicate. Covered in the same spec.
4. **Busy pod never killed:** while a large run is going, scale `large`'s `maxReplicaCount` down and delete idle `default` pods. The large Job runs to the end. `multi-replica.spec.ts` also runs against the two web pods.

**Unchanged and must stay green:** `apps/runner/tests/process/*`, `pnpm docker:e2e` (30/30 after `init: true` moves into the image), and host `pnpm test:e2e`.

## Step 9 — Docs

- **CLAUDE.md:**
  - Commands: the `k8s:*` scripts;
  - a short **Kubernetes rules** block beside *Compose rules*: Job classes, no idle exit on Deployments, liveness never reads the meta-db, `LISTEN` needs a direct connection, never regenerate the key;
  - the provisioner paragraph: the `kubernetes` kind and the `scheduling` reason.
- **`docs/adr/0004-runner-service.md`:** Amendment 2, covering Jobs for on-demand classes instead of `pod-deletion-cost`, why `default` isn't autoscaled, and the opt-in health port (liveness never reads the meta-db).
- **`docs/runner-service-plan.md`:** the Phase 7 bullet points here, and its status line is updated at the end.
- **`docs/web-ui-progress.md`:** an R7 row, IN PROGRESS when work starts and DONE at the end, plus a section with decisions, bugs found and what was verified.
- **`apps/runner/README.md`:** the env table gains `MOVY_RUNNER_MAX_RUNS` and `MOVY_RUNNER_HEALTH_PORT`.
- **`README.md`:** a new "Running on Kubernetes" section with prerequisites, `k8s:up`, and what a node drain does to a run.
- **`apps/web/.env.example`:** `MOVY_PROVISIONER=kubernetes`, `MOVY_K8S_JOB_CLASSES`, `MOVY_K8S_DEPLOYMENT_PREFIX`.
- **GitHub #11:** comment that tickets are done (PR #23) and link this plan.

## Order of work
1. Steps 1–3 (image, agent, view and role): useful in Compose too, and `pnpm docker:e2e` proves nothing regressed.
2. Steps 4–5 (provisioner and UI), unit-tested against fakes.
3. Step 6–7 (chart and kind), then the live checks in Step 8.
4. Step 9 throughout. The progress doc gets its row when step 1 starts.

## Out of scope
- KEDA autoscaling of Deployment classes and `pod-deletion-cost` (a follow-up if needed).
- Ingress, TLS and SSO: that is #20, the production override. The chart leaves an `ingress` stub off by default.
- #9 (org concurrency under parallel launches): not specific to Kubernetes, though two web replicas make it likelier.
- Phase 8: runner classes edited in the UI.

### Plan Verification
- **Depth:** deep by the skill's criteria (migration, shared modules, env, build, more than 5 files). The checks were done inline with grep and read; no subagents were spawned, since none were asked for.
- **Completeness:** gaps found and fixed:
  - liveness must not read the meta-db (mass restart);
  - tini must not use `-g` (a forwarded SIGTERM would cancel runs);
  - Deployment pods must not idle-exit;
  - destination-blocked runs are not KEDA demand;
  - probes need KEDA demand too, or "from large" never wakes a Job;
  - Jobs get `backoffLimit: 0` (no resume);
  - the encryption key survives Helm upgrades;
  - fixtures can't be read from outside the chart;
  - auto mode is refused under `kubernetes`;
  - `runners` rows from Jobs are bounded by the existing day-old sweep;
  - `/api/health` and `ProbeStatus` were confirmed in the code.
- **Blast radius:**
  - Consumers checked: `ProvisionerKind`/`ScaleResult` (`provisioner.ts`, `shared/runner-wire.ts`, `StartRunner.vue`, `scaleSentence`), `QueueReason`/`queueStateOf` (`shared/queue-wire.ts`, `server/runs/queue-state.ts`), `loadClassDemand` (`autoscale.ts`), `RUNNER_GRANTS`/`ensureRunnerRole` and `scripts/runner-role.ts`, `agent-main.ts` `run()`/`IdleWatch`, `x-runner` in `docker-compose.yml`, and `docker/Dockerfile` `runtime`.
  - All wire changes are additive union members. Compose behaviour is unchanged except that `init` moves from Compose into the image, which `docker:e2e` re-proves.
  - Rollback: the chart is new. Migration `0011` only adds a view and the role is optional, so reverting the code leaves both unused.
- **Standards:**
  - Sources: CLAUDE.md (Compose rules, "rebuilt, never cast", the PGlite harness, the read-the-generated-SQL rule, one name rule `isRunnerClassName`, no client library for the Docker API), ADR 0004, `docs/runner-service-plan.md`, and the user rules (small files, immutability, conventional commits).
  - Reuses `IdleWatch`, `stopClaiming()`, `ensureRunnerRole`'s shape, `loadClassDemand`'s rule and `ProvisionerError` handling.
  - Deviations: `default` is not autoscaled (stated, with the reason), and the agent can now listen on a port, opt-in only (Decision 4).
- **Docs & help:**
  - Docs: CLAUDE.md (3 places), ADR 0004, `runner-service-plan.md`, `web-ui-progress.md`, `apps/runner/README.md`, `README.md`, `.env.example`, issue #11.
  - UI strings: `scaleSentence` `on_demand`, `queueSentence` `scheduling`, the probe 503 copy, and the panel's "on demand".
- **Tests:**
  - Updated: `queue-state`/`runner-wire` (new cases only), `runner-role.test.ts` (new role), `autoscale` (now reads the view, same expectations).
  - New: agent config and max runs, health server, kubernetes provisioner, `runner_demand` (PGlite), helm template, `k8s-scaling.spec.ts`.
  - No tests weakened ✅
- **Open questions:** none. All five decisions are made (Decision 4: B, 2026-10-27).

## TLDR: why these changes
- Large runs are rare and heavy. A Job per run uses big resources only while a run needs them, and Jobs are never scaled down mid-run, so the hardest Kubernetes risk disappears without new code in the runner.
- KEDA and auto mode must agree on what demand is, so one database view defines it, and a role that can read only that view keeps runs and connections away from the scaler.
- `tini`, the health check and "no idle exit on Deployments" are the small things that turn a Compose-shaped process into a well-behaved pod.
- The `kubernetes` provisioner and the "on demand" wording keep the UI honest: on a cluster, "no runner online" for `large` is normal, not a problem to fix by hand.
- Helm puts the class list in one place, so the pods, the class file and the provisioner can't drift, and it keeps the encryption key across upgrades.
- The kind checks prove the four promises in #11 against real databases, including SQL Server.
