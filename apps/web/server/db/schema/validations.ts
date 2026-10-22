import {
  pgTable, text, integer, bigint, real, boolean, timestamp, uuid,
  index, primaryKey, foreignKey,
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { connections } from './connections';
import { migrationDefinitions } from './definitions';
import { runs } from './runs';
import { users } from './auth';

/**
 * A comparison is either still counting, or it has an answer.
 *
 * `running` exists because counting is not instant — `COUNT(*)` over every
 * table of a real database takes seconds, and a row written before the counts
 * are in is what lets the page say so rather than appear to have done nothing.
 */
export type ValidationStatus = 'running' | 'succeeded' | 'failed';

export const TERMINAL_VALIDATION_STATUSES: readonly ValidationStatus[] = ['succeeded', 'failed'];

/**
 * One row-count comparison between two databases.
 *
 * Stored rather than rendered and thrown away, which is the whole point: "the
 * counts matched on the 8th" is a claim someone will need to make later, and a
 * screenful that was never written down cannot support it.
 *
 * The endpoint columns are a snapshot for the same reason `runs` carries one —
 * a connection can be renamed, repointed or deleted, and the record of what was
 * compared must not change with it. Engine and database only, the `SafeEndpoint`
 * pair, so a viewer reading a comparison learns no more than one watching a run.
 */
export const validationRuns = pgTable(
  'validation_runs',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),

    /**
     * The migration this comparison was checking, when it was checking one.
     *
     * Nullable on both counts: a comparison can be run against two databases
     * that no migration here has ever touched, and a run it *did* follow may
     * later be deleted without taking the evidence with it.
     */
    runId: uuid('run_id'),
    definitionId: uuid('definition_id'),

    sourceConnectionId: uuid('source_connection_id'),
    targetConnectionId: uuid('target_connection_id'),

    sourceEngine: text('source_engine').notNull(),
    sourceDatabase: text('source_database').notNull(),
    targetEngine: text('target_engine').notNull(),
    targetDatabase: text('target_database').notNull(),

    status: text('status').$type<ValidationStatus>().notNull().default('running'),

    totalSource: bigint('total_source', { mode: 'number' }).notNull().default(0),
    totalDest: bigint('total_dest', { mode: 'number' }).notNull().default(0),
    /**
     * Stored, unlike a run's progress percentage, because it is the answer
     * rather than a view of two other columns: `ValidateCountsUseCase` clamps
     * it at 100, so recomputing it from the totals would quietly disagree with
     * the number the comparison actually reported.
     */
    totalMatchPct: real('total_match_pct').notNull().default(0),
    allMatch: boolean('all_match').notNull().default(false),
    tablesCompared: integer('tables_compared').notNull().default(0),
    tablesMismatched: integer('tables_mismatched').notNull().default(0),

    errorName: text('error_name'),
    errorMessage: text('error_message'),

    requestedByUserId: uuid('requested_by_user_id').references(() => users.id, { onDelete: 'set null' }),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite FKs against each parent's (org_id, id), the same structural
    // isolation `runs` and `migration_definitions` already carry: pointing a
    // comparison at another org's run or connection is a database error rather
    // than something the repository has to remember to forbid.
    foreignKey({
      columns: [t.orgId, t.runId],
      foreignColumns: [runs.orgId, runs.id],
      name: 'validation_runs_run_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [t.orgId, t.definitionId],
      foreignColumns: [migrationDefinitions.orgId, migrationDefinitions.id],
      name: 'validation_runs_definition_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [t.orgId, t.sourceConnectionId],
      foreignColumns: [connections.orgId, connections.id],
      name: 'validation_runs_source_connection_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [t.orgId, t.targetConnectionId],
      foreignColumns: [connections.orgId, connections.id],
      name: 'validation_runs_target_connection_fk',
    }).onDelete('set null'),
    // The comparison history: newest first, one org at a time — and the keyset
    // cursor pages along exactly this order.
    index('validation_runs_org_created_idx').on(t.orgId, t.createdAt),
    // "How did this migration's counts look over its last few comparisons?"
    index('validation_runs_definition_idx').on(t.orgId, t.definitionId, t.createdAt),
  ]
);

/**
 * One table's two counts.
 *
 * Keyed on the parent alone and carrying no `org_id`, exactly as
 * `run_table_progress` is: every read of it is preceded by an org-scoped
 * lookup of the parent, and `ValidationsRepository.requireValidation` is the
 * only way in. A second copy of the scope is a second thing that can disagree.
 */
export const validationTableCounts = pgTable(
  'validation_table_counts',
  {
    validationRunId: uuid('validation_run_id')
      .notNull()
      .references(() => validationRuns.id, { onDelete: 'cascade' }),
    tableName: text('table_name').notNull(),
    sourceCount: bigint('source_count', { mode: 'number' }).notNull().default(0),
    destCount: bigint('dest_count', { mode: 'number' }).notNull().default(0),
    matchPct: real('match_pct').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.validationRunId, t.tableName] })]
);
