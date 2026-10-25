import type { SweepResult } from '@movy/runner/agent';
import { classesToScale, type ClassDemand } from './autoscale';
import type { ClassCapacity, RunnerProvisioner } from './provisioner';

export interface SweepTickDeps {
  /** One pass of the queue sweep; `swept` is false when another replica holds the lock. */
  readonly sweep: () => Promise<SweepResult>;
  readonly provisioner: RunnerProvisioner;
  readonly autoscale: boolean;
  /** Owned by the caller across ticks: when each class was last asked for a runner. */
  readonly lastScaledAt: Map<string, number>;
  readonly now: () => number;
  readonly loadDemand: () => Promise<ClassDemand[]>;
  readonly loadCapacity: (runnerClass: string) => Promise<ClassCapacity>;
  readonly log: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string, detail: string): void;
  };
}

/**
 * One sweeper interval: settle what no runner will, then — on the replica that
 * won the sweep only — tidy provisioned runners and, in auto mode, start one
 * for each class with work it cannot take.
 *
 * Its dependencies are passed in, so the order and the failure isolation below
 * are unit-tested rather than trusted (`runner-sweeper.ts` wires it).
 */
export async function sweepTick(deps: SweepTickDeps): Promise<void> {
  const { swept, settledRuns, offlineRunners } = await deps.sweep();
  if (settledRuns.length > 0) {
    deps.log.warn(`[runs] settled ${settledRuns.length} run(s) whose runner stopped reporting: ${settledRuns.join(', ')}`);
  }
  if (offlineRunners.length > 0) deps.log.info(`[runs] runner(s) offline: ${offlineRunners.join(', ')}`);
  if (!swept) return;

  // Provisioning failures are reported on their own: a missing Docker socket
  // must neither read as a failed sweep nor stop auto mode for every class.
  try {
    const removed = await deps.provisioner.cleanup();
    if (removed > 0) deps.log.info(`[runners] removed ${removed} exited provisioned runner(s).`);
  } catch (err) {
    deps.log.error('[runners] could not remove exited runners:', message(err));
  }

  if (!deps.autoscale) return;
  const now = deps.now();
  for (const runnerClass of classesToScale(await deps.loadDemand(), deps.lastScaledAt, now)) {
    // Set before trying, so a failing provisioner is retried once per cooldown, not every sweep.
    deps.lastScaledAt.set(runnerClass, now);
    try {
      const result = await deps.provisioner.scaleUp(await deps.loadCapacity(runnerClass));
      if (result.status === 'started') deps.log.info(`[runners] auto mode started ${result.container} for queued ${runnerClass} work.`);
    } catch (err) {
      deps.log.error(`[runners] auto mode could not start a ${runnerClass} runner:`, message(err));
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
