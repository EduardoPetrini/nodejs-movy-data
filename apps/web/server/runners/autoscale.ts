import type { SqlClient } from '@movy/runner/agent';

/** What auto mode looks at for each class, across every org: runners are platform-wide. */
export interface ClassDemand {
  readonly name: string;
  readonly queued: number;
  readonly freeSlots: number;
  readonly live: number;
  readonly maxReplicas: number;
}

/** One minute: long enough for a started runner to register before the next is asked for. */
export const AUTOSCALE_COOLDOWN_MS = 60_000;

/**
 * The classes auto mode starts a runner for now: work is waiting, no slot is
 * free to take it, the class is below its cap, and it was not scaled within
 * the cooldown — a container takes several seconds to register, and without
 * the cooldown every sweep in between would start another.
 *
 * Pure: the clock and the last scale times are passed in.
 */
export function classesToScale(
  demand: readonly ClassDemand[],
  lastScaledAt: ReadonlyMap<string, number>,
  now: number,
  cooldownMs = AUTOSCALE_COOLDOWN_MS
): string[] {
  return demand
    .filter((d) => d.queued > 0 && d.freeSlots === 0 && d.live < d.maxReplicas)
    .filter((d) => now - (lastScaledAt.get(d.name) ?? -Infinity) >= cooldownMs)
    .map((d) => d.name);
}

/**
 * Queued work per configured class, as `runner_demand` defines it — the view
 * KEDA reads too, so auto mode and a cluster cannot disagree about demand. A
 * run waiting only on its destination is not counted: another runner would
 * wait on the same lock. Queued probes are left out here: auto mode has
 * always scaled for runs only, and a probe waits seconds, not a cold start.
 */
export async function loadClassDemand(sql: SqlClient): Promise<ClassDemand[]> {
  const { rows } = await sql.query<{ name: string; queued: number; free: number; live: number; max_replicas: number }>(
    `SELECT c.name, c.max_replicas, d.claimable_runs AS queued,
            coalesce(sum(greatest(r.slots - r.busy, 0)) FILTER (WHERE r.state = 'online'), 0)::int AS free,
            count(r.id) FILTER (WHERE r.state IN ('online', 'draining'))::int AS live
       FROM runner_demand d
       JOIN runner_classes c ON c.name = d.runner_class
       LEFT JOIN runners r ON r.class = c.name
      GROUP BY c.name, c.max_replicas, d.claimable_runs`
  );
  return rows.map((r) => ({ name: r.name, queued: r.queued, freeSlots: r.free, live: r.live, maxReplicas: r.max_replicas }));
}
