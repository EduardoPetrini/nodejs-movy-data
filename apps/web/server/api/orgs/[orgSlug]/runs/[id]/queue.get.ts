import { requirePermission } from '~~/server/utils/rbac';
import { useMetaSql } from '~~/server/runs';
import { loadQueueState } from '~~/server/runs/queue-state';

/**
 * Why a queued run has not started. `{ queue: null }` once it has — or when it
 * is not this org's run, which is indistinguishable on purpose.
 */
export default defineEventHandler(async (event) => {
  const org = requirePermission(event, 'run:read');
  const id = getRouterParam(event, 'id')!;
  return { queue: await loadQueueState(useMetaSql(), org.orgId, id) };
});
