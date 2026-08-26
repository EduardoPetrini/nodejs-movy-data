# 1. Direct-pair type translation

Date: 2026-08-26

## Status

Accepted

## Context

Movy translates column types and default values between engines. Today it does this with
one translator and one type map per **Pair** (per direction), e.g.
`MSSQL_TO_POSTGRES_TYPE_MAP` and `MssqlToPostgresTranslator`, with
`CrossDbSchemaTranslator` as a shared base class handling normalised lookup and
precision-suffix propagation.

The cost of this is quadratic in the number of engines. Cross-engine Pairs number
`n × (n − 1)`:

| Engines | Cross-engine Pairs | Type maps | Translators |
|---------|--------------------|-----------|-------------|
| 2 (PG, MySQL) | 2 | 2 | 2 |
| 3 (+ MSSQL) | 6 | 6 | 6 |
| 4 (+ Snowflake) | **12** | **12** | **12** |
| 5 | 20 | 20 | 20 |

Adding Snowflake as engine #4 therefore means writing six new type maps and six new
translators, not two.

The alternative is a **canonical type model**: translate `source → canonical → dest`, so
each engine needs only one inbound and one outbound mapping and the cost becomes linear
(`2n`). At four engines that is 8 mappings instead of 12, and the gap widens with every
engine after that.

## Decision

Keep direct-pair translation. Snowflake enters as engine #4 on the existing design,
accepting 12 type maps and 12 translators.

## Consequences

**What this buys us.** Each mapping is exact for its Pair. MSSQL `datetime2(7)` can map to
PostgreSQL `timestamp(6)` with full knowledge of both sides' precision limits — no
intermediate type has to be general enough to represent every engine's notion of a
timestamp, and no translation is lossy twice. Each map is independently readable and
independently testable; the type-map layer currently sits at 100% coverage precisely
because each file is a flat, total mapping with no conditional logic. A bug in one Pair
cannot regress another.

**What it costs us.** Every engine after this one is more expensive than the last. At five
engines the table above reaches 20 files, and a change to how a single engine represents,
say, unsigned integers must be applied in up to eight places rather than two. There is no
single place to answer "how does Movy think about decimals" — the answer is distributed
across the maps.

**When to revisit.** This decision is cheap to hold at three engines and defensible at
four. It should be reopened before a fifth engine, or at the first sign of the maps
drifting out of agreement with each other. Reversing it later means rewriting every map
against the canonical model, which is mechanical but not small — the cost of reversal
grows with each engine added, which is why it is recorded here rather than left implicit.
