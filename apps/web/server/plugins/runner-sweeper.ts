import { sweep } from '@movy/runner/agent';
import { useMetaSql } from '~~/server/runs';
import { loadClassDemand } from '~~/server/runners/autoscale';
import { loadClassCapacity } from '~~/server/runners/provisioner';
import { sweepTick } from '~~/server/runners/sweep-tick';
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

  function once(): Promise<void> {
    const sql = useMetaSql();
    return sweepTick({
      sweep: () => sweep(sql),
      provisioner: useProvisioner(),
      autoscale: isAutoscale(),
      lastScaledAt,
      now: Date.now,
      loadDemand: () => loadClassDemand(sql),
      loadCapacity: (runnerClass) => loadClassCapacity(sql, runnerClass),
      log: { info: console.info, warn: console.warn, error: console.error },
    });
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
