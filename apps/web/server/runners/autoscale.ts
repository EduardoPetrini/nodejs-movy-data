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
 * Queued work per configured class. A run waiting only on its destination is
 * not demand for a runner — another runner would wait on the same lock — so it
 * is not counted.
 */
export async function loadClassDemand(sql: SqlClient): Promise<ClassDemand[]> {
  const { rows } = await sql.query<{ name: string; queued: number; free: number; live: number; max_replicas: number }>(
    `SELECT c.name, c.max_replicas,
            (SELECT count(*) FROM runs q
              WHERE q.status = 'queued' AND q.runner_class = c.name
                AND (q.target_lock_key IS NULL OR NOT EXISTS (
                      SELECT 1 FROM runs b WHERE b.target_lock_key = q.target_lock_key
                         AND b.status IN ('running', 'cancelling'))))::int AS queued,
            coalesce(sum(greatest(r.slots - r.busy, 0)) FILTER (WHERE r.state = 'online'), 0)::int AS free,
            count(r.id) FILTER (WHERE r.state IN ('online', 'draining'))::int AS live
       FROM runner_classes c LEFT JOIN runners r ON r.class = c.name
      WHERE c.configured
      GROUP BY c.name`
  );
  return rows.map((r) => ({ name: r.name, queued: r.queued, freeSlots: r.free, live: r.live, maxReplicas: r.max_replicas }));
}
