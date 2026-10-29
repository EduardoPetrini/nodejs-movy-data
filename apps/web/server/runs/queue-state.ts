import type { SqlClient } from '@movy/runner/agent';
import { queueStateOf, type QueueState } from '../../shared/queue-wire';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Why this org's queued run is still queued, or null when it is not queued.
 *
 * The org id is in the WHERE clause, so another org's run id answers null. The
 * destination's holder is reported only by whether it is this org's: its id
 * goes back to the client only then. `isOnDemand` is the provisioner's: on a
 * cluster a Job class with no runner up is scheduling one, not missing one.
 */
export async function loadQueueState(
  sql: SqlClient,
  orgId: string,
  runId: string,
  isOnDemand: (runnerClass: string) => boolean = () => false
): Promise<QueueState | null> {
  // A malformed id is simply not a queued run of this org's, not a 500.
  if (!UUID.test(runId)) return null;
  const { rows } = await sql.query<{
    runner_class: string; label: string; online: number; free: number; ahead: number;
    holder_id: string | null; holder_org: string | null;
  }>(
    `WITH me AS (
       SELECT id, runner_class, target_lock_key, created_at FROM runs
        WHERE id = $1 AND org_id = $2 AND status = 'queued'
     ),
     holder AS (
       SELECT b.id, b.org_id FROM runs b, me
        WHERE me.target_lock_key IS NOT NULL AND b.target_lock_key = me.target_lock_key
          AND b.status IN ('running', 'cancelling')
        LIMIT 1
     )
     SELECT me.runner_class, c.label,
            (SELECT count(*) FROM runners r WHERE r.class = me.runner_class AND r.state = 'online')::int AS online,
            (SELECT coalesce(sum(greatest(r.slots - r.busy, 0)), 0) FROM runners r
              WHERE r.class = me.runner_class AND r.state = 'online')::int AS free,
            (SELECT count(*) FROM runs q
              WHERE q.status = 'queued' AND q.org_id = $2 AND q.runner_class = me.runner_class
                AND (q.created_at, q.id) < (me.created_at, me.id))::int AS ahead,
            (SELECT id FROM holder) AS holder_id,
            (SELECT org_id FROM holder) AS holder_org
       FROM me JOIN runner_classes c ON c.name = me.runner_class`,
    [runId, orgId]
  );
  const row = rows[0];
  if (!row) return null;
  return queueStateOf({
    runnerClass: row.runner_class,
    classLabel: row.label,
    onlineRunners: row.online,
    freeSlots: row.free,
    aheadInOrg: row.ahead,
    destinationHeld: row.holder_id !== null,
    blockingRunId: row.holder_org === orgId ? row.holder_id : null,
    onDemand: isOnDemand(row.runner_class),
  });
}
