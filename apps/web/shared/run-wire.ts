/**
 * The contract between the run API/socket and the client.
 *
 * In `shared/` so both halves import the same declarations: a field the
 * serializer stops sending becomes a type error in the reducer, rather than
 * `undefined` at runtime in front of someone watching a migration.
 */

/**
 * The nine timeline nodes, mirroring `MIGRATION_STEP_ORDER` in @movy/core.
 *
 * Restated rather than imported because @movy/core is CommonJS and externalised
 * for Nitro — pulling it into the browser bundle to read one array would drag
 * the whole hexagon with it. `step-order.test.ts` fails if the two ever differ,
 * so this is a copy that cannot rot.
 */
export const RUN_STEP_ORDER = [
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

export type RunStepId = (typeof RUN_STEP_ORDER)[number];

/** What each step is called in the interface. Movy speaks, so: sans, sentence case. */
export const RUN_STEP_LABELS: Record<RunStepId, string> = {
  validate_connections: 'Validate connections',
  create_database: 'Create database',
  inspect_and_diff: 'Inspect and diff schema',
  sync_schema: 'Apply schema',
  disable_triggers: 'Disable constraints',
  migrate_data: 'Copy data',
  enable_triggers: 'Re-enable constraints',
  create_indexes: 'Create indexes',
  reset_sequences: 'Reset sequences',
};

export type RunStatus = 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled';

export const TERMINAL_STATUSES: readonly RunStatus[] = ['succeeded', 'failed', 'cancelled'];

export function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export interface WireEndpoint {
  engine: string;
  database: string;
}

export interface WireRun {
  id: string;
  status: string;
  mode: string;
  simulated: boolean;
  source: WireEndpoint;
  target: WireEndpoint;
  progress: { rowsDone: number; rowsTotal: number; tablesDone: number; tablesTotal: number; pct: number };
  lastSeq: number;
  error: { name: string; message: string } | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  /**
   * The saved migration this run came from, when it came from one.
   *
   * The NAME is joined live rather than snapshotted, unlike the endpoints: a
   * definition is archived and never deleted, so renaming a migration renames
   * it across its whole history at once, which is what someone renaming it
   * meant. A run launched ad hoc has neither.
   */
  definitionId: string | null;
  definitionName: string | null;
  /** Editor and admin only — absent for a viewer, never null. */
  sourceConnectionId?: string | null;
  targetConnectionId?: string | null;
}

export interface WireStep {
  stepId: string;
  ordinal: number;
  status: string;
  detail: unknown;
  durationMs: number | null;
  error: { name: string; message: string } | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface WireTable {
  tableName: string;
  status: string;
  rowsDone: number;
  rowsTotal: number;
  pct: number;
  durationMs: number | null;
  error: string | null;
  finishedAt: string | null;
}

/** One row of the event log, as stored. `payload` is the full MigrationEvent. */
export interface WireEvent {
  seq: number;
  type: string;
  at: string;
  level: string | null;
  payload: Record<string, unknown>;
}

/** Server -> client. The complete inventory; anything else is a protocol error. */
export type ServerFrame =
  | { k: 'hello' }
  | {
      k: 'snapshot';
      run: WireRun;
      steps: WireStep[];
      tables: WireTable[];
      events: WireEvent[];
      lastSeq: number;
      /**
       * Which cohort this subscriber is in.
       *
       * Sent on connect, not only when it CHANGES. A viewer is never demoted
       * mid-session, so without this they learn nothing — and their log pane
       * says "no log output yet" for a run with seventy-five log lines.
       */
      cohort: 'full' | 'redacted';
    }
  | { k: 'events'; runId: string; events: WireEvent[] }
  | { k: 'cohort_changed'; cohort: 'full' | 'redacted' }
  | { k: 'revoked'; reason: string }
  | { k: 'error'; message: string };

/** Client -> server. Exactly one message is accepted, and it carries a ticket. */
export type ClientFrame = { k: 'subscribe'; ticket: string };
