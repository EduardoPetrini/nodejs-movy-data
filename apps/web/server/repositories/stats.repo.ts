import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';

/**
 * What an organisation's home page needs, in as few queries as it takes.
 *
 * A separate repository rather than more methods on `RunsRepository` because
 * it answers questions ACROSS the tables — runs, definitions, comparisons —
 * and none of those tables owns the question. It obeys the same rule as every
 * other repository here: the org id is bound in the constructor and is never a
 * method parameter, so an unscoped query cannot be written.
 */

export interface StatusCount {
  status: string;
  count: number;
}

export interface StatsSummary {
  /** The window these numbers describe, in days. */
  windowDays: number;
  runsByStatus: StatusCount[];
  totalRuns: number;
  activeRuns: number;
  /**
   * Over settled runs in the window, in milliseconds. Null when none settled —
   * a percentile over nothing is not zero, and a dashboard that says "p95: 0ms"
   * for an org that has never run anything is worse than one that says nothing.
   */
  durationP50Ms: number | null;
  durationP95Ms: number | null;
  rowsCopied: number;
  liveDefinitions: number;
  /** Comparisons in the window, and how many of them found every count matching. */
  validations: number;
  validationsAllMatch: number;
  lastRunAt: string | null;
}

const DEFAULT_WINDOW_DAYS = 30;

export class StatsRepository {
  constructor(
    private readonly db: Db,
    private readonly orgId: string
  ) {}

  async summary(windowDays = DEFAULT_WINDOW_DAYS): Promise<StatsSummary> {
    const days = Math.max(1, Math.min(Math.floor(windowDays), 365));

    // Three queries, run together: they touch three different tables, so
    // folding them into one would mean a join whose only purpose is to make
    // the count smaller.
    const [runRows, statusRows, otherRows] = await Promise.all([
      this.db.execute<{
        total: number;
        active: number;
        p50: string | null;
        p95: string | null;
        rows_copied: string | null;
        last_run_at: Date | null;
      }>(sql`
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE status IN ('queued','running','cancelling'))::int AS active,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)
            FILTER (WHERE duration_ms IS NOT NULL) AS p50,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)
            FILTER (WHERE duration_ms IS NOT NULL) AS p95,
          coalesce(sum(rows_done), 0) AS rows_copied,
          max(created_at) AS last_run_at
        FROM runs
        WHERE org_id = ${this.orgId}
          AND created_at >= now() - make_interval(days => ${days})
      `),
      this.db.execute<{ status: string; count: number }>(sql`
        SELECT status, count(*)::int AS count
        FROM runs
        WHERE org_id = ${this.orgId}
          AND created_at >= now() - make_interval(days => ${days})
        GROUP BY status
      `),
      this.db.execute<{ live_definitions: number; validations: number; validations_all_match: number }>(sql`
        SELECT
          (SELECT count(*)::int FROM migration_definitions
            WHERE org_id = ${this.orgId} AND archived_at IS NULL) AS live_definitions,
          (SELECT count(*)::int FROM validation_runs
            WHERE org_id = ${this.orgId}
              AND created_at >= now() - make_interval(days => ${days})) AS validations,
          (SELECT count(*)::int FROM validation_runs
            WHERE org_id = ${this.orgId}
              AND created_at >= now() - make_interval(days => ${days})
              AND status = 'succeeded' AND all_match) AS validations_all_match
      `),
    ]);

    const runs = runRows.rows[0];
    const other = otherRows.rows[0];

    return {
      windowDays: days,
      runsByStatus: statusRows.rows.map((r) => ({ status: r.status, count: r.count })),
      totalRuns: runs?.total ?? 0,
      activeRuns: runs?.active ?? 0,
      // `percentile_cont` returns double precision, which node-pg hands back as
      // a string — the same unchecked-cast trap that made every overall
      // percentage 0 for PostgreSQL sources in Phase 1. Parsed, not trusted.
      durationP50Ms: toNumberOrNull(runs?.p50),
      durationP95Ms: toNumberOrNull(runs?.p95),
      // `sum(bigint)` is numeric, and arrives as a string for the same reason.
      rowsCopied: toNumberOrNull(runs?.rows_copied) ?? 0,
      liveDefinitions: other?.live_definitions ?? 0,
      validations: other?.validations ?? 0,
      validationsAllMatch: other?.validations_all_match ?? 0,
      lastRunAt: runs?.last_run_at ? new Date(runs.last_run_at).toISOString() : null,
    };
  }
}

function toNumberOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}
