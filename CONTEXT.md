# Context

Glossary for Movy. Terms only — no implementation detail, no status, no plans.

## Engine

A database system Movy can talk to: PostgreSQL, MySQL, MSSQL. Snowflake is not yet an
engine — it is a planned one.

An engine is not a unit of completion. A **Pair** is.

## Pair

One **directional** migration route between two engines, e.g. `MSSQL → PostgreSQL`.
Direction matters: `MSSQL → PostgreSQL` and `PostgreSQL → MSSQL` are two Pairs, with
separate type maps and separate translators.

The Pair is the unit users choose in the CLI, and the unit that is or isn't **Done**.
Adding an engine adds `2n` Pairs, where `n` is the number of engines already present,
plus one same-engine Pair.

Avoid **"connector"**. It was used informally to mean both an engine's adapters and a
migration route; those count differently (MSSQL is one Adapter Set but five Pairs), so
the word is retired in favour of Pair and Adapter Set.

## Adapter Set

The per-engine class that wires an engine's adapters — connection, inspector,
synchronizer, query analyzer — into one object the registry can resolve, e.g.
`MssqlAdapterSet`. An implementation term. Never a unit of completion or of status.

## Done

A Pair is **Done** when it is implemented *and* covered by automated tests running
against mocks.

Running against a live database instance is **not** required for a Pair to be Done.
Movy's tests are deliberately mock-driven; a Pair whose adapters are exercised by the
automated suite is complete regardless of whether anyone has pointed it at a real
server. This is a deliberate choice: requiring live instances would make completion
depend on infrastructure nobody has provisioned.

## Planned

An engine or Pair that is designed but not implemented. A Planned engine may appear in
`DatabaseType` and be accepted by CLI input parsing — selecting it fails with a clear
"not yet implemented" error rather than an unhandled crash.
