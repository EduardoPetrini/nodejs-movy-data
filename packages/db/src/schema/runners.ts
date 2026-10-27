import { pgTable, text, integer, bigint, boolean, jsonb, timestamp, uuid, index, customType } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';

/**
 * A kind of runner: `default`, or a larger one for heavy migrations.
 *
 * A row is never deleted while anything names it — runs and, later,
 * definitions reference it — so a class dropped from configuration stays listed
 * as unconfigured instead (docs/runner-service-plan.md, decision 9). Migration
 * 0004 seeds `default`; the rest arrive with Phase 4's class file.
 */
export const runnerClasses = pgTable('runner_classes', {
  name: text('name').primaryKey(),
  label: text('label').notNull(),
  description: text('description'),
  /** Informational: the platform (Compose, Kubernetes) enforces the limits. */
  cpuMillis: integer('cpu_millis'),
  memoryMb: integer('memory_mb'),
  maxReplicas: integer('max_replicas').notNull().default(1),
  /** Suggest this class when the source is larger than this many bytes. */
  suggestAboveBytes: bigint('suggest_above_bytes', { mode: 'number' }),
  isDefault: boolean('is_default').notNull().default(false),
  /**
   * False once the class file stops naming it. The row stays — runs and
   * definitions reference it — but nothing new may be sent to it, and the
   * selector does not offer it. True by default, so a deployment with no
   * class file keeps the `default` that migration 0004 seeded.
   */
  configured: boolean('configured').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type RunnerState = 'online' | 'draining' | 'offline';

/**
 * One runner agent, as it last reported itself.
 *
 * The id is stable across the agent's restarts — `MOVY_RUNNER_ID`, else the
 * hostname, which is the pod or container name — so a restarted agent finds the
 * runs it owned and re-attaches to them rather than leaving them to the sweeper.
 */
export const runners = pgTable('runners', {
  id: text('id').primaryKey(),
  runnerClass: text('class').notNull().references(() => runnerClasses.name),
  version: text('version').notNull(),
  /** Runs it may execute at once. */
  slots: integer('slots').notNull(),
  busy: integer('busy').notNull().default(0),
  /**
   * Probes (Test, Preview) it answers at once — separate from `slots`, so a
   * runner busy with a long migration can still say whether it reaches a
   * database. 0 means it takes none.
   */
  probeSlots: integer('probe_slots').notNull().default(2),
  state: text('state').$type<RunnerState>().notNull(),
  /** Set when a provisioner started it; only those exit when idle. */
  provisionedBy: text('provisioned_by'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }).notNull(),
});

/** Nullable: the request is cleared the moment a runner claims it. */
const sealedBytes = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

export type ProbeKind = 'test' | 'preview';
export type ProbeStatus = 'queued' | 'running' | 'done';

/**
 * A Test or Preview asked of a runner class rather than of the web process
 * (docs/runner-service-plan.md, decision 6): "it works from the console but
 * not from the large runners" is a network fact only a runner can report.
 *
 * Short-lived by construction. The web handler that inserted it waits for
 * `done`, reads the result and deletes the row; `expires_at` lets the sweeper
 * remove one whose handler gave up. The request holds passwords, so it is
 * sealed for this org and this probe (`probeAad`) and set to NULL at claim.
 * The result is already scrubbed of them by the runner.
 */
export const runnerProbes = pgTable(
  'runner_probes',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<ProbeKind>().notNull(),
    runnerClass: text('runner_class').notNull().references(() => runnerClasses.name),
    status: text('status').$type<ProbeStatus>().notNull().default('queued'),
    runnerId: text('runner_id'),
    ciphertext: sealedBytes('ciphertext'),
    result: jsonb('result'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('runner_probes_queue_idx').on(t.runnerClass, t.createdAt)]
);
