/**
 * Run control: the host side of the runner contract.
 *
 * The web console still forks runs through this (docs/runner-service-plan.md,
 * phase 1). It lives beside the runner because the runner agent of phase 2
 * runs the same code, and the two must not drift.
 */
export { EventWriter } from './event-writer';
export type { EventWriterOptions, ProjectionStore } from './event-writer';
export { RunManager } from './run-manager';
export type { LaunchRequest, RunManagerOptions, RunManagerStore, UnsettledRun } from './run-manager';
export { projectEvents } from './run-projection';
export type { EventRow, Projection, RunPatch, StepPatch, TablePatch } from './run-projection';
export { isProcessAlive, readJournalAfter } from './journal-tailer';
export { applyProjection, finaliseRunIfUnsettled, findUnsettledRuns, markRunLaunched } from './ingestion';
