import { DatabaseType } from './connection.types';
import { MigrationResult, TableMigrationPlan } from './migration.types';

/**
 * The nine timeline nodes: connection validation plus the eight numbered steps
 * in MigrationOrchestrator.run(). The comments there (`// Step 1: ...`) are the
 * source of truth for the order; this turns them into observable state.
 */
export type MigrationStepId =
  | 'validate_connections'
  | 'create_database'
  | 'inspect_and_diff'
  | 'sync_schema'
  | 'disable_triggers'
  | 'migrate_data'
  | 'enable_triggers'
  | 'create_indexes'
  | 'reset_sequences';

export const MIGRATION_STEP_ORDER: readonly MigrationStepId[] = [
  'validate_connections',
  'create_database',
  'inspect_and_diff',
  'sync_schema',
  'disable_triggers',
  'migrate_data',
  'enable_triggers',
  'create_indexes',
  'reset_sequences',
] as const;

export type StepStatus = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type RunTerminalStatus = 'succeeded' | 'failed' | 'cancelled';

/**
 * A migration endpoint as it may be shown to ANY viewer.
 *
 * Deliberately carries no host, port, username or password. Events are
 * broadcast to every subscriber of a run, including read-only viewers, so the
 * rule is: events describe progress, never configuration. Connection details
 * live on the run record and go through a role-aware serializer instead.
 */
export interface SafeEndpoint {
  engine: DatabaseType;
  database: string;
}

export interface SerialisedError {
  name: string;
  message: string;
}

export interface SchemaDiffSummary {
  tablesToCreate: number;
  tablesToDrop: number;
  columnsToAdd: number;
  columnsToDrop: number;
  columnsToAlter: number;
  constraintsToAdd: number;
  constraintsToDrop: number;
  indexesToCreate: number;
  indexesToDrop: number;
  sequencesToCreate: number;
  enumsToCreate: number;
}

/** Per-step summary rendered inside an expanded timeline node. */
export type StepDetail =
  | { kind: 'create_database'; database: string; created: boolean }
  | {
      kind: 'inspect_and_diff';
      sourceTables: number;
      sourceSequences: number;
      sourceEnums: number;
      diff: SchemaDiffSummary;
    }
  | { kind: 'triggers'; tables: number }
  | { kind: 'create_indexes'; indexes: number }
  | { kind: 'reset_sequences'; sequences: number }
  | { kind: 'migrate_data'; tables: number; rowsCopied: number; failed: number };

interface EventBase {
  runId: string;
  /** Monotonic per run. Assigned only by SeqSink. The replay cursor. */
  seq: number;
  /** ISO-8601. */
  at: string;
}

export type MigrationEvent =
  | (EventBase & {
      type: 'run_started';
      mode: 'full' | 'query';
      source: SafeEndpoint;
      target: SafeEndpoint;
    })
  | (EventBase & {
      type: 'run_finished';
      status: RunTerminalStatus;
      durationMs: number;
      result?: MigrationResult;
      error?: SerialisedError;
    })
  | (EventBase & { type: 'step_started'; stepId: MigrationStepId; ordinal: number })
  | (EventBase & {
      type: 'step_finished';
      stepId: MigrationStepId;
      status: Exclude<StepStatus, 'pending' | 'running'>;
      durationMs: number;
      detail?: StepDetail;
      error?: SerialisedError;
    })
  | (EventBase & {
      type: 'plan_ready';
      plan: TableMigrationPlan;
      /** Map is not JSON-serialisable and these events cross IPC and sockets. */
      rowEstimates: Record<string, number>;
      workerCount: number;
    })
  | (EventBase & {
      type: 'table_progress';
      tableName: string;
      rowsDone: number;
      rowsTotal: number;
      pct: number;
    })
  | (EventBase & {
      type: 'table_finished';
      tableName: string;
      rowsCopied: number;
      durationMs: number;
      success: boolean;
      error?: string;
    })
  | (EventBase & {
      type: 'overall_progress';
      rowsDone: number;
      rowsTotal: number;
      pct: number;
      tablesDone: number;
      tablesTotal: number;
    })
  | (EventBase & {
      type: 'log';
      level: LogLevel;
      message: string;
      stepId?: MigrationStepId;
    });

export type MigrationEventType = MigrationEvent['type'];

/** Omit that distributes across a union rather than collapsing it. */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/**
 * What producers emit. runId/seq/at are added by SeqSink, so the compiler
 * prevents anything else from inventing a sequence number.
 */
export type MigrationEventInput = DistributiveOmit<MigrationEvent, 'runId' | 'seq' | 'at'>;
