# 4. Runners are a separate, scalable service, and Postgres is their queue

Date: 2026-10-22

## Status

Accepted (2026-10-22): the queue, leases, fencing, the sweeper and the embedded agent are
built (phase 2). Supersedes the "one host" consequences of [ADR 0002](0002-run-execution.md);
keeps its per-run child process and journal.

## Context

ADR 0002 forked one detached runner per run from the web process, and closed with:
*"Nothing here scales past one host. Multi-host deployment means revisiting this
decision, most likely toward the queue."*

That time has come. A migration's resource needs vary by orders of magnitude, and
the UI process should not be where a 4-CPU, 8 GB load runs. Runners must scale on
their own, horizontally (more of them) and vertically (bigger ones). The target is
a Kubernetes cluster, and the UI must show which runners are available even when
nothing is running.

Three queue shapes were considered:

- **BullMQ + Redis.** Mature, fast, well known. It adds a stateful service with its
  own persistence and HA story, and a second record of job state next to
  `runs.status` that can disagree with it. Its default retries are actively
  dangerous here: Movy has no resume, so retrying a half-written destination clears
  it and starts over without anyone deciding to.
- **pg-boss / graphile-worker.** No new service, but each keeps its own jobs table,
  which brings back the two-sources-of-truth problem.
- **The `runs` table itself.** `FOR UPDATE SKIP LOCKED` to claim, `LISTEN/NOTIFY`
  to wake and to broadcast. Movy's job rate (a few an hour) is nowhere near the
  limits of either.

## Decision

**The web app enqueues; runner agents claim.** Launching a run inserts a `queued`
`runs` row and an encrypted `run_specs` row. A long-lived agent of the requested
**runner class** claims it with `SKIP LOCKED` and forks the existing `movy-runner`
child. Its stdin spec, journal-first IPC and exit codes are unchanged.

**Postgres is the queue and the bus.** No Redis. Agents write `run_events` and
projections and `NOTIFY` in the same transaction. A notification is delivered only
on commit, so "broadcast after the durable write" holds by construction. Payloads
are pointers (`runId`, `lastSeq`); listeners read the rows.

**Liveness is a lease, not a pid.** Agents heartbeat every 5 s, extending a 30 s
lease on their runs. A sweeper settles a run whose lease expired as `failed` /
`RunnerVanished`, and **never re-queues it**. An agent whose heartbeat no longer
returns a run it holds kills that child (fencing): a runner that has been declared
dead must not keep writing.

**One active run per destination, across orgs**, enforced by a partial unique index
on a hash of the destination. The per-org concurrency limit could not prevent two
orgs from clearing each other's tables.

**Runners are trusted infrastructure.** They hold the encryption key and
meta-database credentials, ideally through a role limited to the run tables.

**Runner classes** are named pools with fixed resources. They are selected per run
or per definition, and scaled by the platform: Compose `--scale`, a Docker
provisioner in development, KEDA's PostgreSQL scaler in Kubernetes. The review
screen suggests a class from the source tables' **size in bytes**, not their row
count. Bytes are what a heavy run actually spends memory and I/O on. The
suggestion is a hint and never switches the class automatically. Classes are
deploy-time configuration for now; editing them in the UI is a later phase.

## Consequences

- **A run no longer dies with the web app.** Restarting or redeploying the UI is
  safe mid-run. Restarting the runner that owns a run is not, and is reported as
  `RunnerVanished` exactly as before.
- **The 30-minute stall report survives unchanged.** A silent child of a live runner
  keeps its lease. Settling it would free the destination lock for a run that may
  still be writing.
- **Two connections need care.** `LISTEN` requires a direct, unpooled connection;
  PgBouncer in transaction mode silently breaks it.
- **Test connection and Preview gain a second path**: executed on a chosen runner
  class, through the same tables. This answers the question that appears once
  runners live on a different network from the UI.
- **Version skew becomes possible** during rolling deploys. Specs carry a version,
  and an agent that does not understand one fails the run explicitly.
- **Development stays one process.** `MOVY_EMBEDDED_RUNNER=true` runs the same agent
  inside Nitro.

## Amendment 1 — platform operators (2026-10-25)

Runners are platform-wide, but the first version guarded them with an org
permission, `runner:scale`, granted to every org `admin`. Orgs are self-serve, so
an org admin is whoever created the org: any signed-in user could start shared
runners up to each class's cap and read every runner's hostname.

**Decision:** acting on shared infrastructure belongs to a **platform operator**, a
role outside every org. An operator is a `platform_admins` row (granted at runtime,
recorded with who and when) or an email listed in `MOVY_PLATFORM_ADMINS`.

- Self-hosted: the company's platform team, usually from the env list.
- SaaS: the vendor's staff, granted in the table, never a customer.

Starting runners, seeing runner ids, and later editing runner classes and per-org
limits (Phase 8) are an operator's. Org roles keep everything inside the org.

