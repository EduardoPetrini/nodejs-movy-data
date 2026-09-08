import {
  pgTable, text, integer, bigint, smallint, real, boolean, jsonb, timestamp, uuid,
  index, primaryKey, foreignKey,
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { connections } from './connections';
import { users } from './auth';

/**
 * `cancelling` is a real state, not a UI affectation: cancellation is
 * cooperative, so there is a window between the request and the runner
 * observing it at a step boundary. Without it the button either lies or
 * appears not to have worked.
 */
export type RunStatus =
  | 'queued' | 'running' | 'cancelling'
  | 'succeeded' | 'failed' | 'cancelled';

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['succeeded', 'failed', 'cancelled'];

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/**
 * One migration execution.
 *
 * The endpoint columns are a SNAPSHOT, denormalised on purpose: a connection
 * can be renamed, repointed or deleted after a run, and history must keep
 * saying what actually ran. They carry engine and database only — the same
 * fields `SafeEndpoint` carries — so a viewer reading run history learns no
 * more than a viewer watching it live.
 */
export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),

    // Nullable and ON DELETE SET NULL: deleting a connection must not delete
    // the history of what it did.
    sourceConnectionId: uuid('source_connection_id'),
    targetConnectionId: uuid('target_connection_id'),

    sourceEngine: text('source_engine').notNull(),
    sourceDatabase: text('source_database').notNull(),
    targetEngine: text('target_engine').notNull(),
    targetDatabase: text('target_database').notNull(),

    mode: text('mode').$type<'full'>().notNull().default('full'),
    status: text('status').$type<RunStatus>().notNull().default('queued'),

    /** A replayed fixture must never be mistakable for a real migration. */
    simulated: boolean('simulated').notNull().default(false),

    /** Where the runner's NDJSON journal lives. The system of record. */
    journalPath: text('journal_path').notNull(),
    pid: integer('pid'),

    /**
     * The replay cursor: the highest `seq` durably stored in `run_events`.
     * Advanced monotonically with greatest(), because the journal tailer
     * re-delivers events IPC already delivered.
     */
    lastSeq: integer('last_seq').notNull().default(0),

    rowsDone: bigint('rows_done', { mode: 'number' }).notNull().default(0),
    rowsTotal: bigint('rows_total', { mode: 'number' }).notNull().default(0),
    tablesDone: integer('tables_done').notNull().default(0),
    tablesTotal: integer('tables_total').notNull().default(0),

    errorName: text('error_name'),
    errorMessage: text('error_message'),

    requestedByUserId: uuid('requested_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    cancelRequestedByUserId: uuid('cancel_requested_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),

    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite FKs against connections(org_id, id). Attaching another org's
    // connection to a run is then a database-level error, not something the
    // repository layer has to remember to forbid.
    foreignKey({
      columns: [t.orgId, t.sourceConnectionId],
      foreignColumns: [connections.orgId, connections.id],
      name: 'runs_source_connection_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [t.orgId, t.targetConnectionId],
      foreignColumns: [connections.orgId, connections.id],
      name: 'runs_target_connection_fk',
    }).onDelete('set null'),
    // The history list: newest first, one org at a time.
    index('runs_org_created_idx').on(t.orgId, t.createdAt),
    // "Which runs did this process leave behind?" — asked once on every boot.
    index('runs_status_idx').on(t.status),
  ]
);

/**
 * The durable event log — a copy of the journal, queryable.
 *
 * `(run_id, seq)` is the primary key rather than a surrogate id, which is what
 * makes ingestion idempotent: events arrive from IPC AND from the journal
 * tailer after a restart, and both paths can insert the same row. With this
 * key, the second one is an ON CONFLICT DO NOTHING no-op instead of a
 * duplicate the timeline has to de-dupe.
 */
export const runEvents = pgTable(
  'run_events',
  {
    runId: uuid('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
    /** `level` for `log` events, null otherwise. Lifted out so the redacted
     *  log cohort can be filtered in SQL rather than by unpacking jsonb. */
    level: text('level'),
    payload: jsonb('payload').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.seq] }),
    // Fetching just the log stream, or just the timeline, for one run.
    index('run_events_run_type_idx').on(t.runId, t.type, t.seq),
  ]
);

/** Projection: one row per timeline node. Rebuildable from run_events. */
export const runSteps = pgTable(
  'run_steps',
  {
    runId: uuid('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
    stepId: text('step_id').notNull(),
    ordinal: smallint('ordinal').notNull(),
    status: text('status').notNull(),
    detail: jsonb('detail'),
    errorName: text('error_name'),
    errorMessage: text('error_message'),
    durationMs: integer('duration_ms'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.runId, t.stepId] })]
);

/**
 * Projection: one row per table being copied.
 *
 * Exists so the grid is one indexed read instead of a fold over every
 * `table_progress` event — of which a 315k-row run produces thousands even
 * after `ThrottledSink` coalesces them.
 */
export const runTableProgress = pgTable(
  'run_table_progress',
  {
    runId: uuid('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
    tableName: text('table_name').notNull(),
    status: text('status').notNull().default('pending'),
    rowsDone: bigint('rows_done', { mode: 'number' }).notNull().default(0),
    rowsTotal: bigint('rows_total', { mode: 'number' }).notNull().default(0),
    pct: real('pct').notNull().default(0),
    durationMs: integer('duration_ms'),
    error: text('error'),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.runId, t.tableName] })]
);
