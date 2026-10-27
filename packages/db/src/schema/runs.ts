import {
  pgTable, text, integer, bigint, smallint, real, boolean, jsonb, timestamp, uuid,
  index, uniqueIndex, primaryKey, unique, foreignKey, customType,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './orgs';
import { connections } from './connections';
import { migrationDefinitions } from './definitions';
import { users } from './auth';
import { runnerClasses } from './runners';

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

    /**
     * Which saved definition produced this run, when one did.
     *
     * Nullable because an ad-hoc run is still a first-class run — you should
     * not have to name and save a migration before you are allowed to try it
     * once. It is what lets Phase 4 chart the same migration over time.
     */
    definitionId: uuid('definition_id'),

    // Nullable and ON DELETE SET NULL: deleting a connection must not delete
    // the history of what it did.
    sourceConnectionId: uuid('source_connection_id'),
    targetConnectionId: uuid('target_connection_id'),

    sourceEngine: text('source_engine').notNull(),
    sourceDatabase: text('source_database').notNull(),
    targetEngine: text('target_engine').notNull(),
    targetDatabase: text('target_database').notNull(),

    /**
     * Copied from the definition rather than assumed, so the column means
     * something. Only 'full' is launchable today — see
     * `shared/pair-capability.ts`, which is where the refusal is worded.
     */
    mode: text('mode').$type<'full' | 'query'>().notNull().default('full'),
    status: text('status').$type<RunStatus>().notNull().default('queued'),

    /** A replayed fixture must never be mistakable for a real migration. */
    simulated: boolean('simulated').notNull().default(false),

    /**
     * Where the runner's NDJSON journal lives. The system of record.
     *
     * Null until a runner agent claims the run: the path is local to that
     * agent's host, so nothing can name it at enqueue time.
     */
    journalPath: text('journal_path'),
    pid: integer('pid'),

    /** Which kind of runner may claim it. The queue is per class. */
    runnerClass: text('runner_class').notNull().default('default').references(() => runnerClasses.name),
    /** The agent that claimed it. Null while queued, and for runs forked before 0004. */
    runnerId: text('runner_id'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    /**
     * Extended by the owning agent's heartbeat. Once it passes, the sweeper
     * settles the run `RunnerVanished` — and the agent, if it is in fact
     * alive, finds the run missing from its next heartbeat and kills the
     * child. A runner declared dead must never keep writing.
     */
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    /**
     * Which database this run writes to, hashed: sha256 of engine, host, port
     * and database. One run per destination at a time, across every org
     * (decision 5) — two runs into one database clear each other's tables.
     * Null for a simulated run, which writes nowhere. Never serialised: it is
     * derived from another org's credentials as readily as from this one's.
     */
    targetLockKey: text('target_lock_key'),

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
    // Composite FKs against the (org_id, id) of each parent. Attaching another
    // org's connection or definition to a run is then a database-level error,
    // not something the repository layer has to remember to forbid.
    foreignKey({
      columns: [t.orgId, t.definitionId],
      foreignColumns: [migrationDefinitions.orgId, migrationDefinitions.id],
      name: 'runs_definition_fk',
    }).onDelete('set null'),
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
    // Lets `validation_runs` carry a composite FK on (org_id, run_id), the
    // same structural isolation `runs` itself gets from `connections` and
    // `migration_definitions`.
    unique('runs_org_id_uq').on(t.orgId, t.id),
    // The history list: newest first, one org at a time. Also the order the
    // ledger's keyset cursor pages along — `(created_at, id)` descending, with
    // `id` breaking the tie, so two runs created in the same millisecond
    // cannot make a page repeat or skip one.
    index('runs_org_created_idx').on(t.orgId, t.createdAt),
    // "How has this migration behaved over its last ten runs?" — the Phase 4
    // sparkline, and the reason definition_id is worth carrying at all.
    index('runs_definition_idx').on(t.orgId, t.definitionId, t.createdAt),
    // "Which runs did this process leave behind?" — asked once on every boot.
    index('runs_status_idx').on(t.status),
    // The queue: oldest first, one class at a time, queued rows only.
    index('runs_queue_idx').on(t.runnerClass, t.createdAt).where(sql`status = 'queued'`),
    // The destination lock. The claim already skips a busy destination; this
    // is what makes two agents claiming at the same instant safe as well.
    uniqueIndex('runs_target_busy_uq')
      .on(t.targetLockKey)
      .where(sql`status IN ('running', 'cancelling')`),
  ]
);

const bytea = customType<{ data: Buffer; notNull: true }>({ dataType: () => 'bytea' });

/**
 * The run's specification, sealed, from enqueue until a runner claims it.
 *
 * It carries two database passwords, so it is encrypted with an AAD bound to
 * this org and this run (`specAad`), and the claiming agent deletes it as soon
 * as it has read it: no resume exists, so nothing ever needs it twice.
 * `spec_version` lets an agent refuse a shape it does not understand by name
 * rather than guess at it.
 */
export const runSpecs = pgTable('run_specs', {
  runId: uuid('run_id').primaryKey().references(() => runs.id, { onDelete: 'cascade' }),
  specVersion: smallint('spec_version').notNull(),
  ciphertext: bytea('ciphertext').notNull(),
});

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
    /** The full MigrationEvent. Typed so the serializer need not cast. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
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
