import { sweep } from '@movy/runner/agent';
import { useMetaSql } from '~~/server/runs';

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
 * `MOVY_RUNNER_SWEEPER=false` turns it off, for a host that should not.
 */
export default defineNitroPlugin((nitro) => {
  if (process.env.MOVY_RUNNER_SWEEPER === 'false') return;

  let sweeping = false;
  const timer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    sweep(useMetaSql())
      .then(({ settledRuns, offlineRunners }) => {
        if (settledRuns.length > 0) {
          console.warn(`[runs] settled ${settledRuns.length} run(s) whose runner stopped reporting: ${settledRuns.join(', ')}`);
        }
        if (offlineRunners.length > 0) console.info(`[runs] runner(s) offline: ${offlineRunners.join(', ')}`);
      })
      .catch((err: unknown) => console.error('[runs] sweep failed:', err instanceof Error ? err.message : err))
      .finally(() => {
        sweeping = false;
      });
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();

  nitro.hooks.hook('close', () => clearInterval(timer));
});
