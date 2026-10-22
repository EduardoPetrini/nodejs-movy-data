import {
  RUN_STEP_LABELS,
  RUN_STEP_ORDER,
  isTerminal,
  type RunStepId,
  type ServerFrame,
  type WireEvent,
  type WireRun,
  type WireStep,
  type WireTable,
} from '#shared/run-wire'

/**
 * The client-side fold, kept pure and outside any store.
 *
 * Same reasoning as `run-projection.ts` on the server: the rules that are easy
 * to get wrong — de-duplicating an overlap, not un-finishing a table, taking
 * the outcome from the right event — are then testable against the recorded
 * fixture with no component, no socket and no browser in the way.
 *
 * Every function here returns a new state. Nothing is mutated in place, so a
 * Vue ref holding one of these can be replaced wholesale and reactivity is
 * never a question of which nested field was touched.
 */

export interface StepView {
  stepId: RunStepId
  label: string
  status: 'pending' | 'running' | 'ok' | 'failed' | 'skipped'
  durationMs: number | null
  error: { name: string; message: string } | null
  detail: unknown
}

export interface TableView {
  tableName: string
  status: 'pending' | 'running' | 'done' | 'failed'
  rowsDone: number
  rowsTotal: number
  pct: number
  durationMs: number | null
  error: string | null
}

export interface LogLine {
  seq: number
  at: string
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  stepId: string | null
}

export interface RunState {
  run: WireRun | null
  steps: StepView[]
  tables: TableView[]
  logs: LogLine[]
  /** Highest seq applied. What a reconnect asks for events after. */
  lastSeq: number
  /** True once a viewer has been told their cohort no longer includes logs. */
  logsWithheld: boolean
}

/**
 * A long run emits tens of thousands of log lines. Keeping them all is a slow
 * memory leak in a tab someone leaves open overnight, and no one scrolls back
 * that far — the full record is in the journal and in `run_events`.
 */
const MAX_LOG_LINES = 2_000

const STEP_INDEX = new Map<string, number>(RUN_STEP_ORDER.map((id, i) => [id, i]))

export function emptyRunState(): RunState {
  return { run: null, steps: [], tables: [], logs: [], lastSeq: 0, logsWithheld: false }
}

/** Replaces the projections wholesale, then folds in the events that came with them. */
export function applySnapshot(
  snapshot: Extract<ServerFrame, { k: 'snapshot' }>
): RunState {
  const base: RunState = {
    run: snapshot.run,
    steps: buildSteps(snapshot.steps),
    tables: snapshot.tables.map(toTableView).sort(byTableName),
    logs: [],
    // NOT snapshot.lastSeq: that is how far the SERVER has stored, which can be
    // ahead of the events in this payload once the 500-event cap bites. Taking
    // it directly would make a reconnect skip everything in between.
    lastSeq: 0,
    logsWithheld: snapshot.cohort === 'redacted',
  }
  return applyEvents(base, snapshot.events)
}

/**
 * Folds a batch of events on top of the current state.
 *
 * Events at or below `lastSeq` are dropped. The snapshot and the first live
 * batch overlap by design — a peer joins its room before its snapshot is read,
 * so that an event landing in between is duplicated rather than lost — and this
 * is the line that makes that trade safe.
 */
export function applyEvents(state: RunState, events: readonly WireEvent[]): RunState {
  if (events.length === 0) return state

  let run = state.run
  let lastSeq = state.lastSeq
  let steps = state.steps
  let tables = state.tables
  const logs: LogLine[] = []
  let touchedSteps = false
  let touchedTables = false

  const stepMap = new Map(steps.map((s) => [s.stepId, s]))
  const tableMap = new Map(tables.map((t) => [t.tableName, t]))

  for (const event of events) {
    if (event.seq <= lastSeq) continue
    lastSeq = event.seq

    const p = event.payload as Record<string, never>

    switch (event.type) {
      case 'run_started':
        run = run && { ...run, status: 'running', startedAt: event.at }
        break

      case 'run_finished':
        // From the event, never from the last frame received: the producer's
        // throttle flushes a held progress sample on close, so a trailing
        // overall_progress after the terminal event is normal.
        run = run && {
          ...run,
          status: String(p.status),
          finishedAt: event.at,
          durationMs: Number(p.durationMs ?? 0),
          error: (p.error as { name: string; message: string } | undefined) ?? null,
        }
        break

      case 'step_started':
        setStep(stepMap, String(p.stepId), (s) => ({ ...s, status: 'running' }))
        touchedSteps = true
        break

      case 'step_finished':
        setStep(stepMap, String(p.stepId), (s) => ({
          ...s,
          status: normaliseStepStatus(String(p.status)),
          durationMs: Number(p.durationMs ?? 0),
          detail: p.detail ?? s.detail,
          error: (p.error as { name: string; message: string } | undefined) ?? null,
        }))
        touchedSteps = true
        break

      case 'plan_ready': {
        // Seeds the grid so the whole load order is visible before any table
        // starts, rather than tables appearing one at a time with no denominator.
        const order = (p.plan as { loadOrder?: string[] } | undefined)?.loadOrder ?? []
        const estimates = (p.rowEstimates as Record<string, number> | undefined) ?? {}
        for (const tableName of order) {
          if (tableMap.has(tableName)) continue
          tableMap.set(tableName, {
            tableName,
            status: 'pending',
            rowsDone: 0,
            rowsTotal: estimates[tableName] ?? 0,
            pct: 0,
            durationMs: null,
            error: null,
          })
        }
        touchedTables = true
        break
      }

      case 'table_progress':
        setTable(tableMap, String(p.tableName), (t) => ({
          ...t,
          // A finished table never goes back to running. The producer's
          // throttle flushes its held sample after table_finished, so this
          // arrives out of order on essentially every run.
          status: t.status === 'done' || t.status === 'failed' ? t.status : 'running',
          rowsDone: Math.max(t.rowsDone, Number(p.rowsDone ?? 0)),
          rowsTotal: Math.max(t.rowsTotal, Number(p.rowsTotal ?? 0)),
          pct: Math.max(t.pct, Number(p.pct ?? 0)),
        }))
        touchedTables = true
        break

      case 'table_finished':
        setTable(tableMap, String(p.tableName), (t) => ({
          ...t,
          status: p.success ? 'done' : 'failed',
          rowsDone: Number(p.rowsCopied ?? t.rowsDone),
          rowsTotal: Math.max(t.rowsTotal, Number(p.rowsCopied ?? 0)),
          pct: p.success ? 100 : t.pct,
          durationMs: Number(p.durationMs ?? 0),
          error: (p.error as string | undefined) ?? null,
        }))
        touchedTables = true
        break

      case 'overall_progress':
        run = run && {
          ...run,
          progress: {
            rowsDone: Number(p.rowsDone ?? 0),
            rowsTotal: Number(p.rowsTotal ?? 0),
            tablesDone: Number(p.tablesDone ?? 0),
            tablesTotal: Number(p.tablesTotal ?? 0),
            // Capped: rowsCopied over-reports slightly (a row straddling a COPY
            // chunk boundary is counted twice), and a 100.09% bar is a bug report.
            pct: percent(Number(p.rowsDone ?? 0), Number(p.rowsTotal ?? 0)),
          },
        }
        break

      case 'log':
        logs.push({
          seq: event.seq,
          at: event.at,
          level: (event.level as LogLine['level']) ?? 'info',
          message: String(p.message ?? ''),
          stepId: p.stepId ? String(p.stepId) : null,
        })
        break
    }
  }

  if (touchedSteps) steps = [...stepMap.values()].sort(byStepOrder)
  if (touchedTables) tables = [...tableMap.values()].sort(byTableName)

  return {
    run,
    steps,
    tables,
    logs: logs.length > 0 ? capLogs([...state.logs, ...logs]) : state.logs,
    lastSeq,
    logsWithheld: state.logsWithheld,
  }
}

/** Applies any server frame, so a component has one entry point. */
export function applyFrame(state: RunState, frame: ServerFrame): RunState {
  switch (frame.k) {
    case 'snapshot':
      return applySnapshot(frame)
    case 'events':
      return applyEvents(state, frame.events)
    case 'cohort_changed':
      // Say so rather than letting the log pane simply stop: an empty pane
      // that used to have content reads as a bug, not as a permission change.
      return { ...state, logsWithheld: frame.cohort === 'redacted' }
    default:
      return state
  }
}

export function runIsOver(state: RunState): boolean {
  return state.run !== null && isTerminal(state.run.status)
}

function percent(done: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(100, (done / total) * 100)
}

/** Always nine rows, in order, so the timeline has its full shape from the start. */
function buildSteps(rows: readonly WireStep[]): StepView[] {
  const known = new Map(rows.map((r) => [r.stepId, r]))
  return RUN_STEP_ORDER.map((stepId) => {
    const row = known.get(stepId)
    return {
      stepId,
      label: stepLabel(stepId),
      status: row ? normaliseStepStatus(row.status) : 'pending',
      durationMs: row?.durationMs ?? null,
      error: row?.error ?? null,
      detail: row?.detail ?? null,
    }
  })
}

function stepLabel(stepId: RunStepId): string {
  return RUN_STEP_LABELS[stepId]
}

function normaliseStepStatus(status: string): StepView['status'] {
  return status === 'running' || status === 'ok' || status === 'failed' || status === 'skipped'
    ? status
    : 'pending'
}

function toTableView(row: WireTable): TableView {
  return {
    tableName: row.tableName,
    status: (['pending', 'running', 'done', 'failed'] as const).includes(row.status as TableView['status'])
      ? (row.status as TableView['status'])
      : 'pending',
    rowsDone: row.rowsDone,
    rowsTotal: row.rowsTotal,
    pct: row.pct,
    durationMs: row.durationMs,
    error: row.error,
  }
}

function setStep(map: Map<string, StepView>, stepId: string, update: (s: StepView) => StepView): void {
  const existing = map.get(stepId)
  if (!existing) return
  map.set(stepId, update(existing))
}

function setTable(map: Map<string, TableView>, tableName: string, update: (t: TableView) => TableView): void {
  const existing = map.get(tableName) ?? {
    tableName, status: 'pending' as const, rowsDone: 0, rowsTotal: 0, pct: 0, durationMs: null, error: null,
  }
  map.set(tableName, update(existing))
}

function byStepOrder(a: StepView, b: StepView): number {
  return (STEP_INDEX.get(a.stepId) ?? 0) - (STEP_INDEX.get(b.stepId) ?? 0)
}

function byTableName(a: TableView, b: TableView): number {
  return a.tableName.localeCompare(b.tableName)
}

function capLogs(lines: LogLine[]): LogLine[] {
  return lines.length <= MAX_LOG_LINES ? lines : lines.slice(lines.length - MAX_LOG_LINES)
}
