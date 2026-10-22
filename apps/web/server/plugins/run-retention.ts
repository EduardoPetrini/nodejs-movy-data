import { useDb } from '~~/server/db/client';
import { pruneRunEvents } from '~~/server/repositories/runs.repo';

/** Once a day is often enough for a window measured in days. */
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Delay before the first sweep.
 *
 * Boot is the busiest moment this process has — `runs-reattach` is replaying
 * journals — and a retention sweep is the least urgent thing it does.
 */
const FIRST_SWEEP_DELAY_MS = 60_000;

/**
 * Honours `organizations.retention_days`.
 *
 * The column has existed since the first migration and, until now, nothing read
 * it: `run_events` grew without bound for the life of the installation. A run's
 * ledger row, its steps and its per-table rollups are never pruned — only the
 * log lines and progress samples, which are what actually grow with the size of
 * the database being migrated.
 *
 * Failures are logged and swallowed. A sweep that cannot run is a table that
 * grows for another day; a sweep that takes the server down with it is an
 * outage.
 */
export default defineNitroPlugin((nitro) => {
  let timer: NodeJS.Timeout | null = null;

  const sweep = async (): Promise<void> => {
    try {
      const deleted = await pruneRunEvents(useDb());
      if (deleted > 0) console.info(`[retention] pruned ${deleted} run event(s)`);
    } catch (err) {
      console.error('[retention] sweep failed:', err instanceof Error ? err.message : err);
    }
  };

  const first = setTimeout(() => {
    void sweep();
    timer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
    // A retention timer must never be the reason the process stays alive.
    timer.unref?.();
  }, FIRST_SWEEP_DELAY_MS);
  first.unref?.();

  nitro.hooks.hook('close', () => {
    clearTimeout(first);
    if (timer !== null) clearInterval(timer);
  });
});
