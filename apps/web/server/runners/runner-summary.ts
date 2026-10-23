import type { SqlClient } from '@movy/runner/agent';
import type { RunnerClassSummary, RunnerDetail, RunnersSnapshot } from '../../shared/runner-wire';

/**
 * What the runners panel shows, for one org.
 *
 * Runners are platform-wide (decision 3), so capacity is counted across all of
 * them; the queue depth is this org's alone. Runner ids are hostnames — pod or
 * container names — which say something about the infrastructure, so they are
 * read only for an admin and are otherwise not in the answer at all.
 */
export async function loadRunnersSnapshot(
  sql: SqlClient,
  orgId: string,
  options: { includeRunners: boolean }
): Promise<RunnersSnapshot> {
  const { rows } = await sql.query<{
    name: string; label: string; description: string | null; is_default: boolean;
    online: number; draining: number; total_slots: number; free_slots: number; queued: number;
  }>(
    `SELECT c.name, c.label, c.description, c.is_default,
            count(r.id) FILTER (WHERE r.state = 'online')::int AS online,
            count(r.id) FILTER (WHERE r.state = 'draining')::int AS draining,
            coalesce(sum(r.slots) FILTER (WHERE r.state = 'online'), 0)::int AS total_slots,
            coalesce(sum(greatest(r.slots - r.busy, 0)) FILTER (WHERE r.state = 'online'), 0)::int AS free_slots,
            (SELECT count(*) FROM runs q
              WHERE q.status = 'queued' AND q.runner_class = c.name AND q.org_id = $1)::int AS queued
       FROM runner_classes c
       LEFT JOIN runners r ON r.class = c.name
      -- A class the file no longer names takes no new runs, so it has no availability to show.
      WHERE c.configured
      GROUP BY c.name
      ORDER BY c.is_default DESC, c.name`,
    [orgId]
  );

  const classes: RunnerClassSummary[] = rows.map((r) => ({
    name: r.name,
    label: r.label,
    description: r.description,
    isDefault: r.is_default,
    online: r.online,
    draining: r.draining,
    totalSlots: r.total_slots,
    freeSlots: r.free_slots,
    queued: r.queued,
  }));

  const snapshot: RunnersSnapshot = { classes, at: new Date().toISOString() };
  if (!options.includeRunners) return snapshot;

  const detail = await sql.query<{
    id: string; class: string; state: RunnerDetail['state']; version: string;
    slots: number; busy: number; last_heartbeat_at: Date | string;
  }>(
    // An offline runner stays listed for an hour — long enough to see that one
    // just died — and then drops out; the sweeper deletes it after a day.
    `SELECT id, class, state, version, slots, busy, last_heartbeat_at
       FROM runners
      WHERE state <> 'offline' OR last_heartbeat_at > now() - interval '1 hour'
      ORDER BY class, id`
  );
  return {
    ...snapshot,
    runners: detail.rows.map((r) => ({
      id: r.id,
      runnerClass: r.class,
      state: r.state,
      version: r.version,
      slots: r.slots,
      busy: r.busy,
      lastHeartbeatAt: new Date(r.last_heartbeat_at).toISOString(),
    })),
  };
}
