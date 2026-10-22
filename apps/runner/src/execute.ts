import {
  MigrationOrchestrator,
  MigrationCancelledError,
  ConsoleLogger,
  SinkLogger,
  TeeLogger,
  buildRegistry,
} from '@movy/core';
import type { MigrationEventSink, RunTerminalStatus } from '@movy/core';
import type { RunSpec } from './run-spec';

export interface ExecuteOptions {
  readonly emit: MigrationEventSink;
  readonly signal: AbortSignal;
}

/**
 * Runs one real migration.
 *
 * Deliberately thin: the orchestrator already emits run_started, the nine step
 * events and a terminal run_finished for every outcome including cancellation.
 * This function must therefore NOT emit a terminal event of its own — doing so
 * would give the host two, and the second would overwrite the first.
 */
export async function executeRun(
  spec: RunSpec,
  options: ExecuteOptions
): Promise<RunTerminalStatus> {
  const { emit, signal } = options;

  // stderr keeps an operator-readable copy for the case the journal itself is
  // the thing that broke; SinkLogger puts the same lines on the event stream.
  const logger = new TeeLogger([new ConsoleLogger('runner'), new SinkLogger(emit)]);
  const orchestrator = new MigrationOrchestrator(buildRegistry(), logger);

  try {
    const result = await orchestrator.run(spec.source, spec.target, {
      runId: spec.runId,
      emit,
      signal,
    });
    return result.success ? 'succeeded' : 'failed';
  } catch (err) {
    return err instanceof MigrationCancelledError ? 'cancelled' : 'failed';
  }
}
