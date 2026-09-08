import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyEvents, applyFrame, applySnapshot, emptyRunState, runIsOver } from '../../app/utils/run-reducer'
import type { RunState } from '../../app/utils/run-reducer'
import type { ServerFrame, WireEvent, WireRun } from '../../shared/run-wire'

const FIXTURE = join(__dirname, '../../../runner/fixtures/pg-to-pg-315k.ndjson')

/** The recorded run, shaped exactly as the socket delivers it. */
function fixtureEvents(): WireEvent[] {
  return readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .map((p) => ({
      seq: p.seq as number,
      type: p.type as string,
      at: p.at as string,
      level: (p.level as string | undefined) ?? null,
      payload: p,
    }))
}

const RUN: WireRun = {
  id: 'run-1', status: 'queued', mode: 'full', simulated: true,
  source: { engine: 'postgres', database: 'movy_fixture_src' },
  target: { engine: 'postgres', database: 'movy_fixture_dst' },
  progress: { rowsDone: 0, rowsTotal: 0, tablesDone: 0, tablesTotal: 0, pct: 0 },
  lastSeq: 0, error: null,
  createdAt: '2026-09-07T21:29:52.000Z', startedAt: null, finishedAt: null, durationMs: null,
}

function snapshot(over: Partial<Extract<ServerFrame, { k: 'snapshot' }>> = {}) {
  return { k: 'snapshot' as const, run: RUN, steps: [], tables: [], events: [], lastSeq: 0, cohort: 'full' as const, ...over }
}

function stateFromWholeRun(): RunState {
  return applyEvents(applySnapshot(snapshot()), fixtureEvents())
}

describe('the reducer, against the recorded run', () => {
  const state = stateFromWholeRun()

  it('reads the fixture at all (guards against a moved path)', () => {
    expect(fixtureEvents()).toHaveLength(118)
  })

  it('ends succeeded, taking the outcome from run_finished and not the last frame', () => {
    // run_finished is at seq 117 of 118: the producer's throttle flushes a held
    // progress sample on close, so a trailing overall_progress follows it.
    const events = fixtureEvents()
    expect(events[events.length - 1].type).toBe('overall_progress')
    expect(state.run?.status).toBe('succeeded')
    expect(runIsOver(state)).toBe(true)
  })

  it('shows all nine steps complete, in order', () => {
    expect(state.steps).toHaveLength(9)
    expect(state.steps.every((s) => s.status === 'ok')).toBe(true)
    expect(state.steps[0].stepId).toBe('validate_connections')
    expect(state.steps[8].stepId).toBe('reset_sequences')
  })

  it('gives every step a human label rather than its wire id', () => {
    expect(state.steps.map((s) => s.label)).toContain('Copy data')
    expect(state.steps.every((s) => !s.label.includes('_'))).toBe(true)
  })

  it('finishes all five tables', () => {
    expect(state.tables).toHaveLength(5)
    expect(state.tables.every((t) => t.status === 'done')).toBe(true)
    expect(state.tables.every((t) => t.pct === 100)).toBe(true)
  })

  it('collects the log lines', () => {
    expect(state.logs).toHaveLength(75)
    expect(state.logs[0].message).toBe('Validating connections...')
    expect(state.logs.every((l) => l.seq > 0)).toBe(true)
  })

  it('advances lastSeq to the highest seq applied', () => {
    expect(state.lastSeq).toBe(118)
  })
})

describe('overlap between the snapshot and the first live batch', () => {
  it('drops events at or below what it already applied', () => {
    // A peer joins its room BEFORE its snapshot is read, so an event landing in
    // between arrives twice. That trade is only safe because of this.
    const events = fixtureEvents()
    const first = applyEvents(applySnapshot(snapshot()), events.slice(0, 20))
    const overlapped = applyEvents(first, events.slice(10, 30))

    const clean = applyEvents(applySnapshot(snapshot()), events.slice(0, 30))
    expect(overlapped.logs).toHaveLength(clean.logs.length)
    expect(overlapped.lastSeq).toBe(clean.lastSeq)
  })

  it('is unchanged by replaying the whole run a second time', () => {
    const once = stateFromWholeRun()
    const twice = applyEvents(once, fixtureEvents())

    expect(twice.logs).toHaveLength(once.logs.length)
    expect(twice.lastSeq).toBe(once.lastSeq)
    expect(twice.run?.status).toBe('succeeded')
  })

  it('starts its cursor from the events it was given, not from the server cursor', () => {
    // The snapshot caps at 500 events, so `lastSeq` on the run row can be far
    // ahead of the payload. Trusting it would skip everything in between.
    const state = applySnapshot(snapshot({ lastSeq: 5_000, events: fixtureEvents().slice(0, 3) }))
    expect(state.lastSeq).toBe(3)
  })
})

describe('ordering rules', () => {
  let seq = 0
  const ev = (type: string, payload: Record<string, unknown> = {}, level: string | null = null): WireEvent => {
    seq += 1
    const at = new Date(seq * 1000).toISOString()
    return { seq, type, at, level, payload: { type, at, seq, ...payload } }
  }

  it('does not un-finish a table when a flushed progress sample arrives late', () => {
    const state = applyEvents(applySnapshot(snapshot()), [
      ev('table_finished', { tableName: 'orders', rowsCopied: 100, durationMs: 5, success: true }),
      ev('table_progress', { tableName: 'orders', rowsDone: 90, rowsTotal: 100, pct: 90 }),
    ])

    expect(state.tables[0].status).toBe('done')
    expect(state.tables[0].pct).toBe(100)
  })

  it('keeps a failed table failed and keeps its error', () => {
    const state = applyEvents(applySnapshot(snapshot()), [
      ev('table_finished', { tableName: 'items', rowsCopied: 3, durationMs: 1, success: false, error: 'boom' }),
      ev('table_progress', { tableName: 'items', rowsDone: 3, rowsTotal: 10, pct: 30 }),
    ])

    expect(state.tables[0].status).toBe('failed')
    expect(state.tables[0].error).toBe('boom')
  })

  it('seeds the whole load order from plan_ready before any table starts', () => {
    const state = applyEvents(applySnapshot(snapshot()), [
      ev('plan_ready', {
        plan: { loadOrder: ['customers', 'orders', 'items'] },
        rowEstimates: { customers: 10, orders: 20, items: 30 },
        workerCount: 2,
      }),
    ])

    expect(state.tables.map((t) => t.tableName)).toEqual(['customers', 'items', 'orders'])
    expect(state.tables.every((t) => t.status === 'pending')).toBe(true)
    expect(state.tables.find((t) => t.tableName === 'orders')?.rowsTotal).toBe(20)
  })

  it('caps overall progress at 100 — rowsCopied over-reports slightly', () => {
    // A row straddling a COPY chunk boundary is counted twice by the worker.
    const state = applyEvents(applySnapshot(snapshot()), [
      ev('overall_progress', { rowsDone: 315_300, rowsTotal: 315_000, pct: 100.1, tablesDone: 5, tablesTotal: 5 }),
    ])
    expect(state.run?.progress.pct).toBe(100)
  })

  it('reports 0% rather than NaN before a total is known', () => {
    const state = applyEvents(applySnapshot(snapshot()), [
      ev('overall_progress', { rowsDone: 0, rowsTotal: 0, pct: 0, tablesDone: 0, tablesTotal: 0 }),
    ])
    expect(state.run?.progress.pct).toBe(0)
  })

  it('carries a failure onto the run', () => {
    const state = applyEvents(applySnapshot(snapshot()), [
      ev('run_finished', { status: 'failed', durationMs: 12, error: { name: 'MigrationError', message: 'nope' } }),
    ])
    expect(state.run?.status).toBe('failed')
    expect(state.run?.error).toEqual({ name: 'MigrationError', message: 'nope' })
    expect(runIsOver(state)).toBe(true)
  })
})

describe('frames other than events', () => {
  it('knows from the snapshot alone that it is in the redacted cohort', () => {
    // A viewer is never demoted mid-session, so `cohort_changed` never
    // arrives for them. Without the cohort on the snapshot their log pane
    // says "no log output yet" for a run with seventy-five log lines.
    const state = applySnapshot(snapshot({ cohort: 'redacted' }))
    expect(state.logsWithheld).toBe(true)
  })

  it('records that logs were withheld, so an empty pane is explained', () => {
    // A log pane that simply stops reads as a bug rather than as a demotion.
    const state = applyFrame(applySnapshot(snapshot()), { k: 'cohort_changed', cohort: 'redacted' })
    expect(state.logsWithheld).toBe(true)
  })

  it('clears the flag on a promotion', () => {
    let state = applyFrame(applySnapshot(snapshot()), { k: 'cohort_changed', cohort: 'redacted' })
    state = applyFrame(state, { k: 'cohort_changed', cohort: 'full' })
    expect(state.logsWithheld).toBe(false)
  })

  it('ignores frames it has no business acting on', () => {
    const before = applySnapshot(snapshot())
    for (const frame of [{ k: 'hello' }, { k: 'revoked', reason: 'x' }, { k: 'error', message: 'x' }] as ServerFrame[]) {
      expect(applyFrame(before, frame)).toBe(before)
    }
  })
})

describe('empty and degenerate input', () => {
  it('has a usable empty state', () => {
    const state = emptyRunState()
    expect(state.run).toBeNull()
    expect(runIsOver(state)).toBe(false)
    expect(state.steps).toEqual([])
  })

  it('returns the same object for an empty batch', () => {
    const state = applySnapshot(snapshot())
    expect(applyEvents(state, [])).toBe(state)
  })

  it('shows nine pending steps from a snapshot with no step rows yet', () => {
    const state = applySnapshot(snapshot())
    expect(state.steps).toHaveLength(9)
    expect(state.steps.every((s) => s.status === 'pending')).toBe(true)
  })

  it('never mutates the state it was given', () => {
    const before = applySnapshot(snapshot())
    const snapshotOfLogs = before.logs
    applyEvents(before, fixtureEvents())
    expect(before.logs).toBe(snapshotOfLogs)
    expect(before.lastSeq).toBe(0)
  })
})
