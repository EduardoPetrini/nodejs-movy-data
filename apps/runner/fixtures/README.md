# Run fixtures

Recorded `MigrationEvent` journals from real migrations, one JSON event per line.

`apps/runner --simulate <fixture>` replays these with realistic delays, which is
how the web timeline gets built and tested before a database is involved
(Phase 3a). They are also the reference for what a real event stream looks like.

## pg-to-pg-315k.ndjson

PostgreSQL → PostgreSQL, 5 tables, 315,000 rows, recorded against a live server.

- 117 events, `seq` 1..117 with no gaps
- all nine `MIGRATION_STEP_ORDER` steps, each `ok`
- 4 parallel workers (PG→PG is the only Pair that parallelises)
- `overall_progress` climbs monotonically 0.2% → 100.0%
- terminal `run_finished` with `status: "succeeded"`

Contains no credentials: `SafeEndpoint` carries engine and database only, and
the log lines were checked against the live host, port, username and password
before this file was committed. The string `postgres` appears only as a
`DatabaseType` value.

To re-record, point a Movy run at any database with
`--json-events=<path>` and copy the resulting `.events.ndjson`.
