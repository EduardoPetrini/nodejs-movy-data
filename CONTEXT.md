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

## Organization

The tenancy boundary. Every connection, definition, run and comparison belongs to exactly
one organization, and nothing is visible across the line.

A person reaches an organization through a **membership**, which carries one of three
roles — admin, editor, viewer. The role is read per request rather than stored in the
session, so a demotion takes effect on the next request rather than the next sign-in.

Not a billing concept and not a team: it is the scope every query is written against.

## Definition

A saved, repeatable migration: a name, two connections, two databases, and a mode. It is
what makes a run something that can be launched again rather than reassembled from
memory each time.

Definitions are **archived, never deleted**. A run points at the definition that produced
it, and that attribution is the only thing tying a year of history to one migration.
Archiving frees the name for reuse.

## Run

One execution of a migration, from launch to a terminal outcome — succeeded, failed or
cancelled. Its record is durable and outlives the process that produced it.

A run may be **simulated**, meaning a recorded journal was replayed and no database was
touched. That is a property of the run, not a separate kind of thing.

Cancelling a run stops further work; it does **not** undo what has already been written.
Movy has no rollback and no resume, so a cancelled or failed run leaves the destination
partly loaded, and anything reporting one must say so.

## Timeline

The observable shape of a run: nine steps, per-table progress, and log lines, rebuilt by
folding the run's events in `seq` order.

The same fold produces a live view and a finished one — there is no separate "replay"
path — which is what makes a finished run readable a year later from its stored events
alone.

## Comparison

A stored per-table row-count check between two databases, with its own record and its own
history. Distinct from a **run**: it migrates nothing, so the rules about what may be
launched do not apply to it.

## Drift

The difference between two schemas, read after a migration rather than before. It is the
same question a preview answers — "what would a run change?" — asked once the run has
already happened, and is served by the same endpoint and drawn by the same component.
