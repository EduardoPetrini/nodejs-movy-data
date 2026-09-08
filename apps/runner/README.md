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

## Tests

`tests/unit/` covers each module against fakes. `tests/process/` forks the real
binary the way the host will — detached, with IPC — and asserts the contract the
web app depends on: `ready` then events, `cancel` accepted, exit code matching
the outcome, and the journal agreeing with what went over the wire.
