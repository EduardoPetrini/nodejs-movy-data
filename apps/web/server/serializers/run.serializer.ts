import type { OrgRole } from '../db/schema';
import type { RunRow, RunStepRow, RunTableRow, RunEventRow } from '../repositories/runs.repo';

/**
 * What a client is allowed to see of a run.
 *
 * Built up, never torn down — the same rule as the connection serializer. The
 * endpoint fields here are already the safe pair (engine and database), so this
 * is not a redaction so much as a promise that nothing else can creep in: a
 * host or username added to `runs` later still has to be copied deliberately.
 */
export interface PublicRun {
  id: string;
  status: string;
  mode: string;
  simulated: boolean;
  source: { engine: string; database: string };
  target: { engine: string; database: string };
  progress: { rowsDone: number; rowsTotal: number; tablesDone: number; tablesTotal: number; pct: number };
  lastSeq: number;
  error: { name: string; message: string } | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  /** Editor and admin only: which saved connections this run used. */
  sourceConnectionId?: string | null;
  targetConnectionId?: string | null;
}

export function toPublicRun(row: RunRow, role: OrgRole): PublicRun {
  const base: PublicRun = {
    id: row.id,
    status: row.status,
    mode: row.mode,
    simulated: row.simulated,
    source: { engine: row.sourceEngine, database: row.sourceDatabase },
    target: { engine: row.targetEngine, database: row.targetDatabase },
    progress: {
      rowsDone: row.rowsDone,
      rowsTotal: row.rowsTotal,
      tablesDone: row.tablesDone,
      tablesTotal: row.tablesTotal,
      // Derived, never stored: a percentage and its two operands in the same
      // row is three chances to disagree.
      pct: row.rowsTotal > 0 ? Math.min(100, (row.rowsDone / row.rowsTotal) * 100) : 0,
    },
    lastSeq: row.lastSeq,
    error: row.errorMessage ? { name: row.errorName ?? 'Error', message: row.errorMessage } : null,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    durationMs: row.durationMs,
  };

  if (role === 'viewer') return base;

  return {
    ...base,
    sourceConnectionId: row.sourceConnectionId,
    targetConnectionId: row.targetConnectionId,
  };
}

export function toPublicStep(row: RunStepRow) {
  return {
    stepId: row.stepId,
    ordinal: row.ordinal,
    status: row.status,
    detail: row.detail,
    durationMs: row.durationMs,
    error: row.errorMessage ? { name: row.errorName ?? 'Error', message: row.errorMessage } : null,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

export function toPublicTableProgress(row: RunTableRow) {
  return {
    tableName: row.tableName,
    status: row.status,
    rowsDone: row.rowsDone,
    rowsTotal: row.rowsTotal,
    pct: row.pct,
    durationMs: row.durationMs,
    error: row.error,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

export function toPublicEvent(row: RunEventRow) {
  return { seq: row.seq, type: row.type, at: row.at.toISOString(), level: row.level, payload: row.payload };
}

/**
 * The two log cohorts, named once.
 *
 * A viewer has `run:read` but not `run:log:read`: progress, steps and outcome,
 * never the log lines. Movy's logs quote SQL, table names and driver errors,
 * which is exactly the detail a read-only role is not meant to have. The socket
 * rooms in the next step use this same predicate rather than re-deciding.
 */
export function mayReadLogs(role: OrgRole): boolean {
  return role !== 'viewer';
}
