# Run fixtures

Recorded `MigrationEvent` journals from real migrations, one JSON event per line.

`movy-runner --simulate <fixture>` replays these at the recorded pace, which is
how the web timeline gets built and tested before a database is involved
(Phase 3a). They are also the reference for what a real event stream looks like.

```bash
pnpm simulate --journal /tmp/run.ndjson \
  --simulate apps/runner/fixtures/pg-to-pg-315k.ndjson \
  --run-id demo --speed 0.05          # 20x slower than the recording
```

`runId` and `at` are rewritten onto the new run; `seq` is preserved exactly,
because it is the host's replay cursor and the recording is already gapless.

## pg-to-pg-315k.ndjson

PostgreSQL → PostgreSQL, 5 tables, 315,000 rows, recorded against a live server.

- 118 events, `seq` 1..118 with no gaps
- all nine `MIGRATION_STEP_ORDER` steps, each `ok`
- 4 parallel workers (PG→PG is the only Pair that parallelises)
- `overall_progress` climbs monotonically 0.2% → 100.0%
- terminal `run_finished` with `status: "succeeded"` at `seq` 117 — **not the
  last line**. The producer's `ThrottledSink` flushes its held progress sample
  on close, so a trailing `overall_progress` lands after the terminal event.
  Anything reading this stream must take the outcome from the event, never from
  the last line. `fixture-replay.test.ts` pins that.

Contains no credentials: `SafeEndpoint` carries engine and database only, and
the log lines were checked against the live host, port, username and password
before this file was committed. The string `postgres` appears only as a
`DatabaseType` value.

To re-record, point a Movy run at any database with
`--json-events=<path>` and copy the resulting `.events.ndjson`.
