/**
 * Run control: the host side of the runner contract.
 *
 * The runner agent claims queued runs and forks the runner for each. It runs
 * inside the web console by default (embedded); from phase 6 of
 * docs/runner-service-plan.md it also runs as its own service. One codebase,
 * so the two cannot drift.
 */
export { EventWriter } from './event-writer';
export type { EventWriterOptions, ProjectionStore } from './event-writer';
export { RunManager } from './run-manager';
export type { LaunchRequest, RunManagerOptions, RunManagerStore, UnsettledRun } from './run-manager';
export { projectEvents } from './run-projection';
export type { EventRow, Projection, RunPatch, StepPatch, TablePatch } from './run-projection';
export { isProcessAlive, readJournalAfter } from './journal-tailer';
export { applyProjection, finaliseRunIfUnsettled, markRunLaunched } from './ingestion';
export { RunnerAgent, sqlAgentQueue } from './runner-agent';
export type { AgentQueue, AgentRunControl, RunnerAgentOptions } from './runner-agent';
export {
  DEFAULT_LEASE_MS,
  DEFAULT_OFFLINE_AFTER_MS,
  cancelQueuedRun,
  reattachableRuns,
  sweep,
} from './queue-store';
export type { ClaimedRun, HeartbeatResult, RunnerRegistration, SealedSpec, SqlClient, SweepResult } from './queue-store';
export {
  RUN_SPEC_VERSION,
  SUPPORTED_SPEC_VERSIONS,
  RunSpecIncompatibleError,
  openRunSpec,
  sealRunSpec,
} from './run-spec-envelope';
export type { RunSpecEnvelope } from './run-spec-envelope';
export { RUN_EVENTS_CHANNEL, RUNNERS_CHANNEL } from './channels';
