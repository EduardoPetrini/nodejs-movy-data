# 3. Tenancy is enforced by construction, not by remembering

Date: 2026-09-08

## Status

Accepted

## Context

Every connection, definition, run and comparison belongs to one organization, and a
credential leaking across that line is the worst outcome the web app has. The
conventional approach is an `org_id` column plus a `WHERE org_id = ?` on every query, and
its well-known failure is that the clause is a thing a person has to remember, on every
query, forever. One forgotten `WHERE` in one handler is a cross-tenant read, and it looks
exactly like correct code.

Two further pressures are specific to Movy:

- Several tables key on a **parent alone** — `run_events` on `run_id`, `run_steps` on
  `(run_id, step_id)`, `validation_table_counts` on its validation. There is no `org_id`
  on those rows to filter by even if someone wanted to.
- Runs are also read by things that are not requests: the re-attach plugin on boot, the
  journal follower, the retention sweep. Those legitimately have no organization.

## Decision

**The org id enters through the constructor and is never a method parameter.**
`RunsRepository`, `ConnectionsRepository`, `DefinitionsRepository` and
`ValidationsRepository` all take it at construction, so an unscoped query is not something
one can forget to write — it is something one cannot express.

**Child tables are reachable only through a scoped parent lookup.** `requireRun` and
`requireValidation` are the only ways in. A caller holding a `run_id` cannot read its
events without first proving the run is theirs.

**Composite foreign keys carry the org.** `runs` references
`(org_id, connection_id)` and `(org_id, definition_id)` rather than the bare ids, and
`unique('runs_org_id_uq')` on `(org_id, id)` exists to let `validation_runs` do the same.
Attaching another org's connection to a run is therefore a database error, not something
the repository layer has to catch.

**Unscoped access is a separate, named door.** The ingestion and recovery helpers —
`markRunLaunched`, `finaliseRunIfUnsettled`, `findUnsettledRuns`, `pruneRunEvents` — are
free functions taking a `Db`, outside the repository classes. They read as what they are,
and they are few enough to review.

**Role is read per request, never from the session.** Three roles: admin, editor, viewer.
A demotion takes effect on the next request rather than the next sign-in, and reaches a
live socket within one 5-second revalidation interval.

**The socket performs no authorisation at all.** A client POSTs for a single-use 30-second
ticket through an ordinary request that has been through auth, org resolution, a
permission gate and an org-scoped lookup, then redeems it. `roomKey()` is reachable only
with a `SubscriptionGrant`, so no string from the wire can name a room.

## Consequences

**Serializers build up, never tear down.** There is no `delete row.secret` anywhere,
because a field that is never copied cannot be forgotten. `PublicConnection` has no branch
that emits `secret`; viewer-only fields are added after an early return rather than
removed after the fact.

**The log cohort is a predicate, not a filter.** A viewer has `run:read` but not
`run:log:read`, so the events route and the snapshot loader ask only for the non-`log`
types. There is no filtered-out row to leak. `mayReadLogs(role)` and `cohortFor(role)` are
the same rule in two places, and `socket-isolation.test.ts` asserts the source shape
rather than only the behaviour.

**Cross-org isolation is testable without a database.** Room membership is a plain data
structure, so the hub's isolation is a unit test.

**A repository per request is the cost.** Constructing four objects per request is cheap;
the alternative — a singleton taking `orgId` per call — is precisely the API this decision
rejects.

**Nothing here defends against a compromised session.** This is tenancy, not
authentication. The encryption of connection secrets, keyed with `secretAad(orgId, id)`,
is a separate layer and the reason a stolen row from one org cannot be decrypted as
another's.
