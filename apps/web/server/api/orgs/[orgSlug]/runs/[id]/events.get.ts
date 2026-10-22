import { createRepos } from '~~/server/repositories';
import { requirePermission } from '~~/server/utils/rbac';
import { mayReadLogs, toPublicEvent } from '~~/server/serializers/run.serializer';

const LOGLESS_TYPES = [
  'run_started', 'run_finished', 'step_started', 'step_finished',
  'plan_ready', 'table_progress', 'table_finished', 'overall_progress',
] as const;

/**
 * Catch-up: everything after `afterSeq`. This is the same cursor the socket
 * stream will hand a reconnecting client, so both paths agree on what "missed"
 * means.
 *
 * A viewer gets the timeline without the log lines — Movy's logs quote SQL,
 * table names and driver errors. Enforced by only ASKING for the other types,
 * so there is no filtered-out row to leak by accident.
 */
export default defineEventHandler(async (event) => {
  const org = requirePermission(event, 'run:read');
  const query = getQuery(event);
  const id = getRouterParam(event, 'id')!;

  const rows = await createRepos(event).runs.events(id, {
    afterSeq: Number(query.afterSeq) || 0,
    limit: Number(query.limit) || 500,
    types: mayReadLogs(org.role) ? undefined : LOGLESS_TYPES,
  });

  const last = rows.at(-1);
  return {
    events: rows.map(toPublicEvent),
    // Non-null only when a further page exists; the client keeps asking until null.
    nextSeq: last?.seq ?? null,
  };
});
