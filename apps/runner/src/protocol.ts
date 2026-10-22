import type { MigrationEvent, RunTerminalStatus } from '@movy/core';

/**
 * The runner <-> host IPC contract.
 *
 * The channel is a FAST PATH ONLY. The NDJSON journal on disk is the system of
 * record: the runner is forked `detached`, so it outlives a host restart and
 * keeps writing while nobody is listening. Anything that must survive goes to
 * the journal first and to `process.send()` second — never the other way round.
 *
 * Consequence for the host: never treat a missing IPC message as a missing
 * event. Re-attach by tailing the journal from the last `seq` it stored.
 */
export type RunnerToHost =
  | { k: 'ready'; runId: string; pid: number; journalPath: string }
  | { k: 'event'; event: MigrationEvent }
  /** The run could not be reported at all — bad spec, unwritable journal. */
  | { k: 'fatal'; runId: string | null; message: string };

export type HostToRunner = { k: 'cancel' };

/**
 * Exit codes. The three terminal statuses get 0/1/2 so a host that lost its IPC
 * channel can still classify a run from the exit code alone; the 64/70 pair
 * follows sysexits.h and means the run never started.
 */
export const RUNNER_EXIT = {
  succeeded: 0,
  failed: 1,
  cancelled: 2,
  /** Bad argv or an unparseable run spec. */
  usage: 64,
  /** The runner itself broke: unwritable journal, uncaught exception. */
  internal: 70,
} as const;

export type RunnerExitCode = (typeof RUNNER_EXIT)[keyof typeof RUNNER_EXIT];

export function exitCodeForStatus(status: RunTerminalStatus): RunnerExitCode {
  return RUNNER_EXIT[status];
}

/**
 * IPC payloads arrive as `unknown` and a malformed one must not be able to
 * cancel a run by accident, so every inbound message is narrowed here.
 */
export function isHostToRunner(value: unknown): value is HostToRunner {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { k?: unknown }).k === 'cancel'
  );
}
