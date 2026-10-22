import { MIGRATION_STEP_ORDER } from '@movy/core';
import type { MigrationEvent, MigrationStepId } from '@movy/core';
import type { RunStatus } from '../db/schema';

/**
 * Folds a batch of events into the three projections, as plain data.
 *
 * Pure and outside the database on purpose — the same reason `run-reducer.ts`
 * sits outside the client store. Every interesting rule here (a terminal status
 * is taken from the event and not from arrival order; `lastSeq` only ever
 * climbs; a table that reports progress after finishing does not un-finish) is
 * then testable against the recorded fixture with no Postgres in the room.
 */

export interface RunPatch {
  status?: RunStatus;
  lastSeq?: number;
  rowsDone?: number;
  rowsTotal?: number;
  tablesDone?: number;
  tablesTotal?: number;
  startedAt?: Date;
  finishedAt?: Date;
  durationMs?: number;
  errorName?: string | null;
  errorMessage?: string | null;
}

export interface StepPatch {
  stepId: MigrationStepId;
  ordinal: number;
  status: string;
  detail?: unknown;
  errorName?: string | null;
  errorMessage?: string | null;
  durationMs?: number;
  startedAt?: Date;
  finishedAt?: Date;
}

export interface TablePatch {
  tableName: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  rowsDone: number;
  rowsTotal: number;
  pct: number;
  durationMs?: number;
  error?: string | null;
  finishedAt?: Date;
}

export interface EventRow {
  runId: string;
  seq: number;
  type: string;
  at: Date;
  level: string | null;
  payload: MigrationEvent;
}

export interface Projection {
  readonly events: readonly EventRow[];
  readonly run: RunPatch;
  readonly steps: readonly StepPatch[];
  readonly tables: readonly TablePatch[];
}

const ORDINALS = new Map<MigrationStepId, number>(
  MIGRATION_STEP_ORDER.map((id, i) => [id, i])
);

/** `step_finished` statuses map straight through; only `ok` is renamed for the UI. */
function stepOrdinal(stepId: MigrationStepId): number {
  return ORDINALS.get(stepId) ?? ORDINALS.size;
}

export function projectEvents(events: readonly MigrationEvent[]): Projection {
  const rows: EventRow[] = [];
  const run: RunPatch = {};
  const steps = new Map<string, StepPatch>();
  const tables = new Map<string, TablePatch>();

  for (const event of events) {
    const at = new Date(event.at);
    rows.push({
      runId: event.runId,
      seq: event.seq,
      type: event.type,
      at,
      level: event.type === 'log' ? event.level : null,
      payload: event,
    });

    // Monotonic: the journal tailer re-delivers events IPC already delivered,
    // and a cursor that could move backwards would re-tail them forever.
    run.lastSeq = Math.max(run.lastSeq ?? 0, event.seq);

    switch (event.type) {
      case 'run_started':
        run.status = 'running';
        run.startedAt = at;
        break;

      case 'run_finished':
        run.status = event.status;
        run.finishedAt = at;
        run.durationMs = event.durationMs;
        run.errorName = event.error?.name ?? null;
        run.errorMessage = event.error?.message ?? null;
        break;

      case 'step_started':
        upsertStep(steps, {
          stepId: event.stepId,
          ordinal: event.ordinal,
          status: 'running',
          startedAt: at,
        });
        break;

      case 'step_finished':
        upsertStep(steps, {
          stepId: event.stepId,
          ordinal: stepOrdinal(event.stepId),
          status: event.status,
          detail: event.detail,
          durationMs: event.durationMs,
          errorName: event.error?.name ?? null,
          errorMessage: event.error?.message ?? null,
          finishedAt: at,
        });
        break;

      case 'plan_ready': {
        // Seeds the grid so every table has a row before it starts copying —
        // otherwise tables appear one at a time and the UI has no denominator.
        run.tablesTotal = event.plan.loadOrder.length;
        let total = 0;
        for (const tableName of event.plan.loadOrder) {
          const rowsTotal = event.rowEstimates[tableName] ?? 0;
          total += rowsTotal;
          upsertTable(tables, {
            tableName,
            status: 'pending',
            rowsDone: 0,
            rowsTotal,
            pct: 0,
          });
        }
        run.rowsTotal = total;
        break;
      }

      case 'table_progress':
        upsertTable(tables, {
          tableName: event.tableName,
          status: 'running',
          rowsDone: event.rowsDone,
          rowsTotal: event.rowsTotal,
          pct: event.pct,
        });
        break;

      case 'table_finished':
        upsertTable(tables, {
          tableName: event.tableName,
          status: event.success ? 'done' : 'failed',
          rowsDone: event.rowsCopied,
          // A finished table's own report is authoritative for its total.
          rowsTotal: Math.max(event.rowsCopied, tables.get(event.tableName)?.rowsTotal ?? 0),
          pct: event.success ? 100 : (tables.get(event.tableName)?.pct ?? 0),
          durationMs: event.durationMs,
          error: event.error ?? null,
          finishedAt: at,
        });
        break;

      case 'overall_progress':
        run.rowsDone = event.rowsDone;
        run.rowsTotal = event.rowsTotal;
        run.tablesDone = event.tablesDone;
        run.tablesTotal = event.tablesTotal;
        break;

      case 'log':
        break;
    }
  }

  return { events: rows, run, steps: [...steps.values()], tables: [...tables.values()] };
}

/**
 * Later wins per field, but a terminal state is never walked back.
 *
 * `ThrottledSink` flushes its held progress sample on close, so a
 * `table_progress` for an already-finished table legitimately arrives after
 * its `table_finished`. Without this guard that table would flip back to
 * running and stay there for the rest of the run.
 */
const TERMINAL_TABLE = new Set(['done', 'failed']);

function upsertTable(map: Map<string, TablePatch>, patch: TablePatch): void {
  const existing = map.get(patch.tableName);
  if (!existing) {
    map.set(patch.tableName, patch);
    return;
  }
  if (TERMINAL_TABLE.has(existing.status) && !TERMINAL_TABLE.has(patch.status)) {
    // Keep the terminal row; take only the total, which can still be corrected.
    map.set(patch.tableName, { ...existing, rowsTotal: Math.max(existing.rowsTotal, patch.rowsTotal) });
    return;
  }
  map.set(patch.tableName, { ...existing, ...patch });
}

function upsertStep(map: Map<string, StepPatch>, patch: StepPatch): void {
  const existing = map.get(patch.stepId);
  map.set(patch.stepId, existing ? { ...existing, ...patch } : patch);
}
