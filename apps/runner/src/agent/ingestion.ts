import { and, eq, notInArray, sql } from 'drizzle-orm';
import { runEvents, runSteps, runTableProgress, runs, TERMINAL_RUN_STATUSES } from '@movy/db';
import type { Db, RunStatus } from '@movy/db';
import type { Projection } from './run-projection';

type RunRow = typeof runs.$inferSelect;

/**
 * Ingestion, deliberately NOT org-scoped. It used to sit beside the org-scoped
 * RunsRepository in the web app, and moved here with the RunManager it serves.
 *
 * It is called by the RunManager and the journal tailer, which are driven by a
 * runner process and have no request and no user. It writes only rows keyed on
 * a run id that the caller already fetched, and it is never reachable from a
 * route handler — `route-scoping.test.ts` sees to that.
 */
export async function applyProjection(db: Db, runId: string, projection: Projection): Promise<void> {
  if (projection.events.length === 0 && Object.keys(projection.run).length === 0) return;

  await db.transaction(async (tx) => {
    if (projection.events.length > 0) {
      await tx
        .insert(runEvents)
        // A MigrationEvent is a plain JSON object by construction — it has just
        // been through the journal and, for a real run, an IPC round trip. The
        // cast is only because a TS interface has no implicit index signature.
        .values(
          projection.events.map((e) => ({
            ...e,
            runId,
            payload: e.payload as unknown as Record<string, unknown>,
          }))
        )
        // Idempotent by primary key: IPC and the journal tailer both deliver
        // the same events, and neither may produce a duplicate the timeline
        // has to reason about.
        .onConflictDoNothing();
    }

    for (const step of projection.steps) {
      await tx
        .insert(runSteps)
        .values({ runId, ...step, detail: step.detail ?? null })
        .onConflictDoUpdate({
          target: [runSteps.runId, runSteps.stepId],
          set: {
            status: sql`excluded.status`,
            detail: sql`coalesce(excluded.detail, ${runSteps.detail})`,
            errorName: sql`excluded.error_name`,
            errorMessage: sql`excluded.error_message`,
            durationMs: sql`coalesce(excluded.duration_ms, ${runSteps.durationMs})`,
            startedAt: sql`coalesce(${runSteps.startedAt}, excluded.started_at)`,
            finishedAt: sql`coalesce(excluded.finished_at, ${runSteps.finishedAt})`,
          },
        });
    }

    for (const table of projection.tables) {
      await tx
        .insert(runTableProgress)
        .values({ runId, ...table })
        .onConflictDoUpdate({
          target: [runTableProgress.runId, runTableProgress.tableName],
          set: {
            // A table that has finished never goes back to running, whichever
            // order a re-tail delivers its events in.
            status: sql`case when ${runTableProgress.status} in ('done','failed')
                             and excluded.status not in ('done','failed')
                        then ${runTableProgress.status} else excluded.status end`,
            rowsDone: sql`greatest(${runTableProgress.rowsDone}, excluded.rows_done)`,
            rowsTotal: sql`greatest(${runTableProgress.rowsTotal}, excluded.rows_total)`,
            pct: sql`greatest(${runTableProgress.pct}, excluded.pct)`,
            durationMs: sql`coalesce(excluded.duration_ms, ${runTableProgress.durationMs})`,
            error: sql`coalesce(excluded.error, ${runTableProgress.error})`,
            finishedAt: sql`coalesce(excluded.finished_at, ${runTableProgress.finishedAt})`,
          },
        });
    }

    const patch = projection.run;
    await tx
      .update(runs)
      .set({
        ...patch,
        // The cursor only ever climbs. A re-tail that delivers older events
        // must not rewind it, or the tailer loops on the same range forever.
        ...(patch.lastSeq === undefined
          ? {}
          : { lastSeq: sql`greatest(${runs.lastSeq}, ${patch.lastSeq})` as unknown as number }),
        updatedAt: new Date(),
      })
      .where(eq(runs.id, runId));
  });
}

/** Records what the runner reported about itself once it came up. */
export async function markRunLaunched(
  db: Db,
  runId: string,
  info: { pid: number; journalPath: string }
): Promise<void> {
  await db
    .update(runs)
    .set({ pid: info.pid, journalPath: info.journalPath, updatedAt: new Date() })
    .where(eq(runs.id, runId));
}

/**
 * Settles a run that has no terminal event of its own.
 *
 * Reached when the runner exits without emitting `run_finished` — it was killed,
 * it crashed, or the host found it already dead on boot. The guard is what
 * matters: a run that DID report its outcome keeps it, because the event is
 * always more informative than an exit code.
 */
export async function finaliseRunIfUnsettled(
  db: Db,
  runId: string,
  outcome: { status: Extract<RunStatus, 'succeeded' | 'failed' | 'cancelled'>; errorName?: string; errorMessage?: string }
): Promise<boolean> {
  const settled = await db
    .update(runs)
    .set({
      status: outcome.status,
      errorName: outcome.errorName ?? null,
      errorMessage: outcome.errorMessage ?? null,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(runs.id, runId), notInArray(runs.status, [...TERMINAL_RUN_STATUSES])))
    .returning({ id: runs.id });
  return settled.length > 0;
}

/** Every run this host may still owe an outcome to. Asked once, on boot. */
export async function findUnsettledRuns(db: Db): Promise<RunRow[]> {
  return db.select().from(runs).where(notInArray(runs.status, [...TERMINAL_RUN_STATUSES]));
}
