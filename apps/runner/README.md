# @movy/runner

The run driver. Forked once per migration run by the web app, and owner of the
process-level concerns `@movy/core` deliberately refuses: argv, stdin, signals,
IPC framing, the event journal and exit codes.

```bash
# Replay a recorded run — no database involved.
pnpm simulate --journal /tmp/run.ndjson \
  --simulate apps/runner/fixtures/pg-to-pg-315k.ndjson \
  --run-id demo --speed 0.05

# Run a real migration. The spec goes in on stdin, never in argv.
echo "$SPEC_JSON" | node apps/runner/dist/main.js --journal /var/movy/runs/<id>.ndjson
```

## Two modes, one path downstream

`--simulate` replays a recorded journal; the default mode drives
`MigrationOrchestrator` against real databases. Both funnel into the same
`publish()`, so the journal, the IPC stream, and everything the host builds on
top of them cannot tell the two apart. That is the point: the web timeline, its
projections and its socket fan-out are exercised against simulated runs, and a
real run then needs no separate handling.

The one asymmetry is sequencing. A real run's events go through `composeSink`,
which assigns `seq`; recorded events already carry one and bypass it, since a
second `SeqSink` would renumber them and break the host's cursor.

## Load-bearing decisions

**The spec arrives on stdin, not in argv.** `ps` is readable by every user on
the host and the spec carries two database passwords. The host writes one JSON
object and closes the pipe; the secret never touches the filesystem. A timeout
covers the case where the host dies between fork and write.

**`RunSpecError` names the field, never the value.** That message is written to
stderr and sent to the host as a `fatal`, and two of the fields it validates are
passwords. `run-spec.test.ts` asserts the password cannot appear in one.

**Every IPC call is guarded on `process.connected`.** Not decoration: after the
host dies `process.send` still *exists*, so `process.send?.(...)` calls it
anyway, Node emits an unhandled `'error'` on `process`, and the runner dies a
few events into being orphaned. `process.disconnect?.()` had the same flaw, and
threw into the top-level catch — reporting exit 70, *the run never started*, for
a run that had completed. Removing these guards turns the journal from a system
of record back into a log of whatever the host was awake for.
`tests/process/host-death.test.ts` kills a real parent mid-replay and asserts
the orphan finishes.

**The journal is the system of record; IPC is a copy.** The runner is forked
`detached`, so it outlives a host restart and keeps writing while nobody is
listening. Every event is journalled *before* it is sent. The host re-attaches
by reading the file forward from the last `seq` it stored — that is what
`JournalTailer` is for in Phase 3a — so a missing IPC message must never be read
as a missing event.

**Exit codes classify a run without IPC.** 0/1/2 are succeeded/failed/cancelled;
64 (bad argv or spec) and 70 (the runner itself broke) mean the run never
started. A host that lost its channel can still tell what happened from `exit`.

**Cancellation is cooperative.** SIGTERM, SIGINT and an IPC `{k:'cancel'}` all
abort the same `AbortController`. The orchestrator observes it at step
boundaries and between tables — an in-flight `COPY` or `CREATE INDEX` cannot be
interrupted from Node without per-driver support.

## Options

| Flag | Meaning |
|------|---------|
| `--journal <path>` | NDJSON journal to append to. Required. |
| `--simulate <fixture>` | Replay a recording instead of connecting to a database. |
| `--speed <n>` | Replay rate. `1` is the recorded pace, `0.05` is 20x slower. |
| `--run-id <id>` | Required with `--simulate`; otherwise taken from the spec. |
| `--stdin-timeout <ms>` | How long to wait for the spec (default 10000). |

## The host side: `src/agent/`

The code that forks this process, reads its IPC and journal, and folds the events
into the metadata database lives here too, exported as `@movy/runner/agent`:
`RunManager`, `EventWriter`, `projectEvents`, the journal tailer and the ingestion
helpers, and `RunnerAgent`, which claims queued runs from the metadata database. The
web console can run an agent in-process (embedded); `src/agent-main.ts` is the same
agent as its own process — `movy-runner-agent`, what the Compose runner services run.
That is why the modules sit beside the contract they implement rather than in the web app.

```bash
MOVY_DATABASE_URL=postgres://movy_runner:…@meta-db:5432/movy_data \
MOVY_ENCRYPTION_KEY=… MOVY_RUNNER_CLASS=default node dist/agent-main.js
```

| Variable | Default | |
|---|---|---|
| `MOVY_DATABASE_URL` (or `NUXT_DATABASE_URL`) | — | The meta-db, as the `movy_runner` role. Required. |
| `MOVY_ENCRYPTION_KEY` (or `NUXT_ENCRYPTION_KEY`) | — | The console's key; every run spec is sealed with it. Required. |
| `MOVY_RUNNER_CLASS` | `default` | The class it claims runs and probes for. |
| `MOVY_RUNNER_ID` | hostname | Stable across restarts, so it re-attaches to its own runs. |
| `MOVY_RUNNER_SLOTS` / `MOVY_RUNNER_PROBE_SLOTS` | 1 / 2 | Runs and probes at once. |
| `MOVY_JOURNAL_DIR` | `$TMPDIR/movy-journals` | Replica-local journals. |
| `MOVY_RUNNER_DRAIN_MS` | 110000 | How long SIGTERM waits for live runs. Never cancels one. |
| `MOVY_RUNNER_PROVISIONED_BY` | unset | Set by a provisioner; only then does it exit when idle… |
| `MOVY_RUNNER_IDLE_EXIT_MS` | 600000 | …after this long with no run and no probe. |
| `MOVY_RUNNER_MAX_RUNS` | unset (unlimited) | Claim this many runs, then stop claiming and exit 0 once they have settled. `1` is a Kubernetes Job's agent: one Job, one run. |
| `MOVY_RUNNER_HEALTH_PORT` | unset | Serves `GET /livez` (its own clock is ticking; never reads the meta-db) and `GET /readyz` (started, not draining) for a kubelet. Unset, the agent listens on nothing. |

A bad value is refused at boot with exit 64, naming the variable.

## Tests

`tests/unit/` covers each module against fakes, `tests/unit/agent/` the host side. `tests/process/` forks the real
binary the way the host will — detached, with IPC — and asserts the contract the
web app depends on: `ready` then events, `cancel` accepted, exit code matching
the outcome, and the journal agreeing with what went over the wire.
