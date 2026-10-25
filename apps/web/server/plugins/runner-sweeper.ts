import { sweep } from '@movy/runner/agent';
import { useMetaSql } from '~~/server/runs';
import { classesToScale, loadClassDemand } from '~~/server/runners/autoscale';
import { loadClassCapacity } from '~~/server/runners/provisioner';
import { isAutoscale, useProvisioner } from '~~/server/runners/use-provisioner';

/** Ten seconds: a lost run is settled within a lease plus one sweep. */
const SWEEP_INTERVAL_MS = 10_000;

/**
 * Settles what no runner will: runs whose lease expired because their runner
 * died, and runners that stopped heartbeating. One web replica sweeps at a
 * time — the statement takes a transaction-scoped advisory lock and the others
 * skip — so this runs on every replica without coordination.
 *
 * A settled run is `RunnerVanished`, with the "may be partially applied"
 * warning: Movy has no resume. Its runner, if it was alive after all, finds the
 * run missing from its next heartbeat and stops it.
 *
 * The replica that swept also tidies provisioned runners that have exited and,
 * in auto mode (`MOVY_AUTOSCALE=true`), starts one for a class with work
 * queued and no free slot. Only that replica: two replicas each starting a
 * runner for the same queued run is the race the lock already settles.
 *
 * `MOVY_RUNNER_SWEEPER=false` turns it off, for a host that should not.
 */
export default defineNitroPlugin((nitro) => {
  if (process.env.MOVY_RUNNER_SWEEPER === 'false') return;

  const lastScaledAt = new Map<string, number>();
  let sweeping = false;

  async function once(): Promise<void> {
    const sql = useMetaSql();
    const { swept, settledRuns, offlineRunners } = await sweep(sql);
    if (settledRuns.length > 0) {
      console.warn(`[runs] settled ${settledRuns.length} run(s) whose runner stopped reporting: ${settledRuns.join(', ')}`);
    }
    if (offlineRunners.length > 0) console.info(`[runs] runner(s) offline: ${offlineRunners.join(', ')}`);
    if (!swept) return;

    // Provisioning failures are reported on their own: a missing Docker socket
    // must neither read as a failed sweep nor stop auto mode for every class.
    const provisioner = useProvisioner();
    try {
      const removed = await provisioner.cleanup();
      if (removed > 0) console.info(`[runners] removed ${removed} exited provisioned runner(s).`);
    } catch (err) {
      console.error('[runners] could not remove exited runners:', err instanceof Error ? err.message : err);
    }

    if (!isAutoscale()) return;
    const now = Date.now();
    for (const runnerClass of classesToScale(await loadClassDemand(sql), lastScaledAt, now)) {
      // Set before trying, so a failing provisioner is retried once per cooldown, not every sweep.
      lastScaledAt.set(runnerClass, now);
      try {
        const result = await provisioner.scaleUp(await loadClassCapacity(sql, runnerClass));
        if (result.status === 'started') console.info(`[runners] auto mode started ${result.container} for queued ${runnerClass} work.`);
      } catch (err) {
        console.error(`[runners] auto mode could not start a ${runnerClass} runner:`, err instanceof Error ? err.message : err);
      }
    }
  }

  const timer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    once()
      .catch((err: unknown) => console.error('[runs] sweep failed:', err instanceof Error ? err.message : err))
      .finally(() => {
        sweeping = false;
      });
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();

  nitro.hooks.hook('close', () => clearInterval(timer));
});
