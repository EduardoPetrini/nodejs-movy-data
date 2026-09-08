import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { useDb } from '../db/client';
import { runEvents, runSteps, runTableProgress, runs } from '../db/schema';
import { toPublicEvent, toPublicRun, toPublicStep, toPublicTableProgress } from '../serializers/run.serializer';
import type { SubscriptionGrant } from './run-hub';

/** Timeline event types — everything a redacted subscriber is allowed. */
const LOGLESS_TYPES = [
  'run_started', 'run_finished', 'step_started', 'step_finished',
  'plan_ready', 'table_progress', 'table_finished', 'overall_progress',
] as const;

/** Recent history a client needs to render a run it just opened. */
const RECENT_EVENT_LIMIT = 500;

/**
 * The opening state of a run for one subscriber.
 *
 * Read with the grant's org id in the WHERE clause, not just its run id. The
 * grant was already produced by an org-scoped lookup, so this is belt and
 * braces — but it means this query is safe to read on its own terms, without
 * knowing how the grant was made.
 *
 * Not routed through `createRepos()` because there is no H3Event here: a
 * WebSocket peer is not a request. The org scoping is therefore written out
 * explicitly, which is why the role serializer is applied on the way out too.
 */
export async function loadRunSnapshot(grant: SubscriptionGrant) {
  const db = useDb();

  const [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, grant.runId), eq(runs.orgId, grant.orgId)))
    .limit(1);

  if (!run) throw new Error('run not found for this grant');

  // The cohort decides which types are ASKED for. A row that is never fetched
  // cannot be leaked by a serializer that forgets to drop it.
  const typeFilter =
    grant.cohort === 'full' ? undefined : inArray(runEvents.type, [...LOGLESS_TYPES]);

  const [steps, tables, events] = await Promise.all([
    db.select().from(runSteps).where(eq(runSteps.runId, grant.runId)).orderBy(asc(runSteps.ordinal)),
    db.select().from(runTableProgress).where(eq(runTableProgress.runId, grant.runId)).orderBy(asc(runTableProgress.tableName)),
    db
      .select()
      .from(runEvents)
      .where(typeFilter ? and(eq(runEvents.runId, grant.runId), gt(runEvents.seq, 0), typeFilter) : eq(runEvents.runId, grant.runId))
      .orderBy(asc(runEvents.seq))
      .limit(RECENT_EVENT_LIMIT),
  ]);

  // `viewer` rather than the real role: a redacted cohort is exactly the
  // viewer projection, and a full cohort is editor-or-better by construction.
  const role = grant.cohort === 'full' ? 'editor' : 'viewer';

  return {
    run: toPublicRun(run, role),
    steps: steps.map(toPublicStep),
    tables: tables.map(toPublicTableProgress),
    events: events.map(toPublicEvent),
    /** Everything at or below this seq is already in `events`. */
    lastSeq: run.lastSeq,
    // So the client can say WHY its log pane is empty, rather than implying
    // the run produced no output.
    cohort: grant.cohort,
  };
}
