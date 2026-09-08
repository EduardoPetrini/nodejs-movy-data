import { and, desc, eq, gt, inArray, notInArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { runEvents, runSteps, runTableProgress, runs, TERMINAL_RUN_STATUSES } from '../db/schema';
import type { RunStatus } from '../db/schema';
import type { Projection } from '../runs/run-projection';

export type RunRow = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type RunStepRow = typeof runSteps.$inferSelect;
export type RunTableRow = typeof runTableProgress.$inferSelect;
export type RunEventRow = typeof runEvents.$inferSelect;

/**
 * Like ConnectionsRepository: the org id arrives through the constructor and is
 * never a method parameter, so an unscoped query cannot be written.
 *
 * Child tables key on `run_id` alone, so every one of those queries is
 * preceded by a scoped lookup of the run itself. `requireRun` is that lookup,
 * and the only way in.
 */
export class RunsRepository {
  constructor(
    private readonly db: Db,
    private readonly orgId: string
  ) {}

  async list(limit = 50): Promise<RunRow[]> {
    return this.db
      .select()
      .from(runs)
      .where(eq(runs.orgId, this.orgId))
      .orderBy(desc(runs.createdAt))
      .limit(limit);
  }

  /** Undefined for a run in another org — indistinguishable from absent. */
  async findById(id: string): Promise<RunRow | undefined> {
    const rows = await this.db
      .select()
      .from(runs)
      .where(and(eq(runs.id, id), eq(runs.orgId, this.orgId)))
      .limit(1);
    return rows[0];
  }

  async countActive(): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(runs)
      .where(
        and(
          eq(runs.orgId, this.orgId),
          notInArray(runs.status, [...TERMINAL_RUN_STATUSES])
        )
      );
    return row?.n ?? 0;
  }

  async create(row: Omit<NewRun, 'orgId'>): Promise<RunRow> {
    const [created] = await this.db
      .insert(runs)
      .values({ ...row, orgId: this.orgId })
      .returning();
    // RETURNING on a single-row INSERT always yields a row; the type says
    // "maybe" because it describes bulk inserts too.
    if (!created) throw new Error('insert into runs returned no row');
    return created;
  }

  async steps(runId: string): Promise<RunStepRow[]> {
    await this.requireRun(runId);
    return this.db.select().from(runSteps).where(eq(runSteps.runId, runId)).orderBy(runSteps.ordinal);
  }

  async tableProgress(runId: string): Promise<RunTableRow[]> {
    await this.requireRun(runId);
    return this.db
      .select()
      .from(runTableProgress)
      .where(eq(runTableProgress.runId, runId))
      .orderBy(runTableProgress.tableName);
  }

  /**
   * Events after `afterSeq`, which is how a reconnecting client catches up
   * without refetching a run's whole history.
   */
  async events(
    runId: string,
    options: { afterSeq?: number; limit?: number; types?: readonly string[] } = {}
  ): Promise<RunEventRow[]> {
    await this.requireRun(runId);
    const filters = [eq(runEvents.runId, runId), gt(runEvents.seq, options.afterSeq ?? 0)];
    if (options.types?.length) filters.push(inArray(runEvents.type, [...options.types]));

    return this.db
      .select()
      .from(runEvents)
      .where(and(...filters))
      .orderBy(runEvents.seq)
      .limit(Math.min(options.limit ?? 500, 2000));
  }

  async requestCancel(runId: string, userId: string): Promise<RunRow | undefined> {
    const [updated] = await this.db
      .update(runs)
      .set({ status: 'cancelling', cancelRequestedAt: new Date(), cancelRequestedByUserId: userId, updatedAt: new Date() })
      .where(
        and(
          eq(runs.id, runId),
          eq(runs.orgId, this.orgId),
          // Cancelling an already-finished run must be a no-op, not a status
          // that overwrites the outcome it actually had.
          notInArray(runs.status, [...TERMINAL_RUN_STATUSES])
        )
      )
      .returning();
    return updated;
  }

  private async requireRun(runId: string): Promise<RunRow> {
    const run = await this.findById(runId);
    if (!run) throw createError({ statusCode: 404, statusMessage: 'Not Found' });
    return run;
  }
}

/**
 * Ingestion, deliberately NOT org-scoped and deliberately not on the class above.
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
        .values(projection.events.map((e) => ({ ...e, runId })))
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
