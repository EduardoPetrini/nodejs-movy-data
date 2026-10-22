# 2. The runner is a forked process and its journal is the system of record

Date: 2026-09-08

## Status

Accepted

## Context

`MigrationOrchestrator` is a library. Something has to give it a process: argv, stdin,
signals, a place to put events, and an outcome. The web app needs that something to
survive its own restarts, because a migration takes minutes to hours and a Nitro dev
server, a deploy or a crash takes seconds.

Three shapes were available.

**In-process.** Call the orchestrator inside the Nitro request handler or a background
task. Simplest by a wide margin, and wrong for the reason above: a deploy in the middle
of a 40-minute migration would leave the destination half-loaded with nobody able to say
so, and Movy has no resume. It also puts a CPU-bound worker pool inside the process
serving the UI.

**A job queue.** A durable queue and a separate worker fleet. The right answer for a
product with many tenants and many machines, and a large amount of infrastructure —
another service to run, another failure mode to understand — for a tool whose current
deployment is one host.

**A forked child per run.** One process per run, `detached`, writing an append-only
NDJSON journal, talking to the host over IPC.

The hard part is not the fork. It is that IPC **cannot be re-established**: the channel
dies with the parent. A host that restarts mid-run can never hear from that child again,
even though the child is still running and still writing to the destination.

## Decision

Fork one detached runner per run. **The journal is the system of record; IPC is a copy.**

Every event is written to the journal *before* `process.send()`. The host re-attaches by
reading the journal forward from the last `seq` it stored, so a missing IPC message is
never a missing event. `run_events` is keyed on `(run_id, seq)` with no surrogate id,
which makes the second delivery of an event an `ON CONFLICT DO NOTHING` no-op rather than
a duplicate.

Re-attachment is a **follow**, not a one-shot read: a run still in flight after a restart
has its journal re-read every second until a terminal event or the owning process is
gone. A run whose process vanished with no outcome is settled `failed` / `RunnerVanished`,
and the message says the migration may be partially applied.

The run spec arrives on **stdin, never argv**: `ps` is world-readable on a shared host and
the spec carries two database passwords.

Exit codes carry the outcome (0/1/2 = succeeded/failed/cancelled; 64 bad argv or spec, 70
the runner itself broke), so a host that lost its channel can still classify a run it
merely watched exit.

## Consequences

**A run outlives the host, on purpose.** `shutdown()` detaches without killing. This is
the desired behaviour and also means a stuck runner is not cleaned up by restarting the
web app.

**Cancellation is cooperative and lossy.** The host sends an IPC message, or SIGTERM to a
child it did not fork. The runner aborts at a step, table or batch boundary — an in-flight
`COPY` or `CREATE INDEX` cannot be interrupted from Node without per-driver support. And
nothing is rolled back, so every surface reporting a cancellation must say the destination
is partly written.

**Two delivery paths must stay idempotent.** Any future change to `run_events`'
primary key breaks re-attachment. The key is load-bearing, not incidental.

**A live-but-wedged runner cannot be settled automatically.** The watchdog reports a run
that has been silent for 30 minutes; it does not fail it, because marking a live run
failed frees its concurrency slot and lets a second run launch into a destination the
first is still writing to. Diagnosing a stall is left to a person.

**The journal must be scrubbed.** It is written by the same `composeSink` pipeline that
feeds IPC and the socket, so redaction happens once, at that seam, and covers all three.

**Nothing here scales past one host.** Journals are local paths and pids are local pids.
Multi-host deployment means revisiting this decision, most likely toward the queue.
