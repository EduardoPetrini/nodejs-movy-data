import { and, desc, eq, lt, or } from 'drizzle-orm';
import type { Db } from '../db/client';
import { migrationDefinitions, validationRuns, validationTableCounts } from '../db/schema';
import { clampLimit, toPage, type Page, type PageCursor } from './paging';

export type ValidationRow = typeof validationRuns.$inferSelect;
export type NewValidation = typeof validationRuns.$inferInsert;
export type ValidationTableRow = typeof validationTableCounts.$inferSelect;

/** A comparison plus the name of the migration it was checking, when it had one. */
export interface ValidationListRow {
  validation: ValidationRow;
  definitionName: string | null;
}

export type ValidationPage = Page<ValidationListRow>;

/**
 * Like every other repository here: the org id arrives through the constructor
 * and is never a method parameter, so a query without a scope cannot be
 * written.
 *
 * `validation_table_counts` carries no `org_id` of its own — it keys on its
 * parent alone, as `run_table_progress` does — so every read of it goes through
 * `requireValidation`, which is the org-scoped lookup and the only way in.
 */
export class ValidationsRepository {
  constructor(
    private readonly db: Db,
    private readonly orgId: string
  ) {}

  /**
   * One page of comparison history, newest first.
   *
   * Left-joined to `migration_definitions` rather than snapshotting the name on
   * the row: a definition is archived and never deleted, so the join always
   * finds it, and a renamed migration reads under its current name everywhere
   * at once. That is the opposite choice from the endpoint columns, and
   * deliberately so — a name is a label, a host is a fact about what ran.
   */
  async page(options: { limit?: number; cursor?: PageCursor; definitionId?: string } = {}): Promise<ValidationPage> {
    const limit = clampLimit(options.limit);
    const filters = [eq(validationRuns.orgId, this.orgId)];
    if (options.definitionId) filters.push(eq(validationRuns.definitionId, options.definitionId));
    if (options.cursor) filters.push(beforeCursor(options.cursor));

    // One more than asked for, so "is there another page?" is answered by the
    // rows themselves rather than by a second COUNT over the whole table.
    const rows = await this.db
      .select({ validation: validationRuns, definitionName: migrationDefinitions.name })
      .from(validationRuns)
      .leftJoin(migrationDefinitions, eq(migrationDefinitions.id, validationRuns.definitionId))
      .where(and(...filters))
      .orderBy(desc(validationRuns.createdAt), desc(validationRuns.id))
      .limit(limit + 1);

    return toPage(rows, limit, (row) => row.validation);
  }

  /** Undefined for another org's comparison — indistinguishable from absent. */
  async findById(id: string): Promise<ValidationListRow | undefined> {
    const rows = await this.db
      .select({ validation: validationRuns, definitionName: migrationDefinitions.name })
      .from(validationRuns)
      .leftJoin(migrationDefinitions, eq(migrationDefinitions.id, validationRuns.definitionId))
      .where(and(eq(validationRuns.id, id), eq(validationRuns.orgId, this.orgId)))
      .limit(1);
    return rows[0];
  }

  async tableCounts(validationId: string): Promise<ValidationTableRow[]> {
    await this.requireValidation(validationId);
    return this.db
      .select()
      .from(validationTableCounts)
      .where(eq(validationTableCounts.validationRunId, validationId))
      .orderBy(validationTableCounts.tableName);
  }

  async create(row: Omit<NewValidation, 'orgId'>): Promise<ValidationRow> {
    const [created] = await this.db
      .insert(validationRuns)
      .values({ ...row, orgId: this.orgId })
      .returning();
    if (!created) throw new Error('insert into validation_runs returned no row');
    return created;
  }

  /**
   * Store the counts and settle the comparison, in one transaction.
   *
   * Together because a comparison that says `succeeded` with no rows under it
   * is worse than one that says nothing: the page would render an answer of
   * "0 tables compared, all matched", which is a false all-clear.
   */
  async complete(
    id: string,
    summary: {
      totalSource: number;
      totalDest: number;
      totalMatchPct: number;
      allMatch: boolean;
      tablesCompared: number;
      tablesMismatched: number;
      durationMs: number;
    },
    tables: readonly { tableName: string; sourceCount: number; destCount: number; matchPct: number }[]
  ): Promise<void> {
    await this.requireValidation(id);

    await this.db.transaction(async (tx) => {
      if (tables.length > 0) {
        await tx
          .insert(validationTableCounts)
          .values(tables.map((t) => ({ validationRunId: id, ...t })))
          .onConflictDoNothing();
      }
      await tx
        .update(validationRuns)
        .set({ ...summary, status: 'succeeded', finishedAt: new Date() })
        .where(and(eq(validationRuns.id, id), eq(validationRuns.orgId, this.orgId)));
    });
  }

  /** Settle a comparison that could not finish. The reason is the whole record. */
  async fail(id: string, error: { name: string; message: string }, durationMs: number): Promise<void> {
    await this.db
      .update(validationRuns)
      .set({
        status: 'failed',
        errorName: error.name,
        errorMessage: error.message,
        finishedAt: new Date(),
        durationMs,
      })
      .where(and(eq(validationRuns.id, id), eq(validationRuns.orgId, this.orgId)));
  }

  private async requireValidation(id: string): Promise<ValidationRow> {
    const found = await this.findById(id);
    if (!found) throw createError({ statusCode: 404, statusMessage: 'Not Found' });
    return found.validation;
  }
}

/**
 * "Strictly older than the cursor", in the same order the index is in.
 *
 * The tie-break on `id` is what makes the page boundary exact: without it, two
 * rows sharing a `created_at` straddling the boundary are either both returned
 * or both skipped.
 */
function beforeCursor(cursor: PageCursor) {
  const at = new Date(cursor.createdAt);
  return or(
    lt(validationRuns.createdAt, at),
    and(eq(validationRuns.createdAt, at), lt(validationRuns.id, cursor.id))
  )!;
}
