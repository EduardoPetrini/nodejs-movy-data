import { and, desc, eq, gt, inArray, lt, notInArray, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { migrationDefinitions, runEvents, runSteps, runTableProgress, runs, TERMINAL_RUN_STATUSES } from '../db/schema';
import type { RunStatus } from '../db/schema';
import type { Projection } from '../runs/run-projection';
import { clampLimit, toPage, type Page, type PageCursor } from './paging';

export type RunRow = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type RunStepRow = typeof runSteps.$inferSelect;
export type RunTableRow = typeof runTableProgress.$inferSelect;
export type RunEventRow = typeof runEvents.$inferSelect;

/** A run plus the name of the definition it came from, when it came from one. */
export interface RunListRow {
  run: RunRow;
  definitionName: string | null;
}

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

  /**
   * One page of run history, newest first.
   *
   * Keyset, not `OFFSET`: this is a list with rows arriving at its head while
   * it is being read. Under an offset, a run launched between page one and page
   * two shifts everything down by one, so the reader sees a run twice and never
   * sees another — on the one screen whose job is to be a complete record.
   *
   * The definition name is joined rather than snapshotted onto the row. A
   * definition is archived and never deleted, so the join always finds it, and
   * a renamed migration reads under its current name across all of history at
   * once. The endpoint columns go the other way for the opposite reason: a
   * name is a label, a database is a fact about what ran.
   */
  async page(options: { limit?: number; cursor?: PageCursor; status?: RunStatus; definitionId?: string } = {}): Promise<Page<RunListRow>> {
    const limit = clampLimit(options.limit);
    const filters = [eq(runs.orgId, this.orgId)];
    if (options.status) filters.push(eq(runs.status, options.status));
    if (options.definitionId) filters.push(eq(runs.definitionId, options.definitionId));
    if (options.cursor) filters.push(beforeRunCursor(options.cursor));

    // One more than asked for, so the existence of a next page is answered by
    // the rows themselves rather than by a COUNT that would not agree with them.
    const rows = await this.db
      .select({ run: runs, definitionName: migrationDefinitions.name })
      .from(runs)
      .leftJoin(migrationDefinitions, eq(migrationDefinitions.id, runs.definitionId))
      .where(and(...filters))
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(limit + 1);

    return toPage(rows, limit, (row) => row.run);
  }

  /**
   * The last `perDefinition` durations of every definition that has ever run,
   * newest first — the ledger's sparklines, in one query.
   *
   * One query rather than one per definition because the alternative is N+1 on
   * a page that already renders N rows. `runs_definition_idx` is
   * `(org_id, definition_id, created_at)`, which is exactly what the window
   * partition walks.
   *
   * Only settled runs with a duration count. A run still in flight has no
   * duration yet, and charting a zero for it would draw a cliff that says
   * "this migration got instantly faster" every time one starts.
   */
  async durationsByDefinition(perDefinition = 10): Promise<Map<string, number[]>> {
    const limit = Math.max(1, Math.min(Math.floor(perDefinition), 50));

    // Raw SQL rather than the query builder: a windowed subquery is where
    // Drizzle's typing stops helping and starts needing casts, and a cast
    // around a query that must stay org-scoped is exactly the wrong place to
    // silence the compiler. The org id is still bound, as a parameter.
    const result = await this.db.execute<{ definition_id: string; durations: number[] }>(sql`
      SELECT definition_id, array_agg(duration_ms ORDER BY rank DESC) AS durations
      FROM (
        SELECT
          definition_id,
          duration_ms,
          row_number() OVER (
            PARTITION BY definition_id ORDER BY created_at DESC, id DESC
          ) AS rank
        FROM runs
        WHERE org_id = ${this.orgId}
          AND definition_id IS NOT NULL
          AND duration_ms IS NOT NULL
      ) ranked
      WHERE rank <= ${limit}
      GROUP BY definition_id
    `);

    // `rank DESC` inside array_agg puts the oldest first, which is the
    // direction a sparkline is read: left is then, right is now.
    return new Map(result.rows.map((row) => [row.definition_id, row.durations]));
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
 * "Strictly older than the cursor", in the order the index is already in.
 *
 * The tie-break on `id` is what makes the boundary exact. Two runs created in
 * the same millisecond is not a hypothetical — launching a definition twice is
 * one click apart — and without the tie-break a pair straddling the boundary
 * is either returned twice or skipped entirely.
 */
function beforeRunCursor(cursor: PageCursor) {
  const at = new Date(cursor.createdAt);
  return or(lt(runs.createdAt, at), and(eq(runs.createdAt, at), lt(runs.id, cursor.id)))!;
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

/**
 * Deletes `run_events` rows older than the owning org's retention window.
 *
 * Unscoped by design: retention is a background sweep across every org, and the
 * per-org window comes from the join rather than from a caller — an
 * org-scoped version would need the caller to already know which orgs exist,
 * which is exactly the loop this replaces.
 *
 * Only `run_events` is pruned. `runs`, `run_steps` and `run_table_progress` are
 * the ledger and stay forever: they are small, bounded by the number of runs
 * and tables rather than by the size of the data, and deleting them would make
 * a year of history vanish rather than merely lose its narration. What a
 * pruned run loses is its log lines and its per-batch samples; what it keeps is
 * every number the history, comparison and drift screens draw.
 *
 * A run still in flight is never touched, however old its first events are:
 * pruning underneath a live reader would make the timeline it is watching go
 * backwards.
 */
export async function pruneRunEvents(
  db: Db,
  options: { now?: Date; limit?: number } = {}
): Promise<number> {
  const now = options.now ?? new Date();
  // Bounded so one sweep cannot hold a lock long enough to stall live writes.
  // The sweep runs daily and is idempotent, so an incomplete pass simply
  // continues tomorrow.
  const limit = options.limit ?? 50_000;

  const deleted = await db.execute(sql`
    DELETE FROM run_events
    WHERE (run_id, seq) IN (
      SELECT e.run_id, e.seq
      FROM run_events e
      JOIN runs r ON r.id = e.run_id
      JOIN organizations o ON o.id = r.org_id
      WHERE r.status IN ('succeeded', 'failed', 'cancelled')
        -- A window of zero or less means "keep everything", never "delete
        -- everything". Nothing writes this column yet, so today it is always
        -- the default 30 — but the day it becomes an org setting, the reading
        -- that silently purges a year of timelines must not be the one a
        -- careless 0 selects. make_interval(days => 0) would do exactly that.
        AND o.retention_days > 0
        AND e.at < ${now}::timestamptz - make_interval(days => o.retention_days)
      LIMIT ${limit}
    )
  `);

  return typeof deleted.rowCount === 'number' ? deleted.rowCount : 0;
}
