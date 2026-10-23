import { pgTable, text, integer, bigint, boolean, timestamp } from 'drizzle-orm/pg-core';

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
  state: text('state').$type<RunnerState>().notNull(),
  /** Set when a provisioner started it; only those exit when idle. */
  provisionedBy: text('provisioned_by'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }).notNull(),
});
