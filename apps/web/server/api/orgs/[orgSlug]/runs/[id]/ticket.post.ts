import { createRepos } from '~~/server/repositories';
import { requirePermission } from '~~/server/utils/rbac';
import { cohortFor } from '~~/server/runs/run-hub';
import { useTicketStore } from '~~/server/runs';

/**
 * Mints a one-shot ticket for this run's event stream.
 *
 * Every authorisation decision the socket will rely on is made HERE, on an
 * ordinary request that has already been through auth, org resolution, the
 * permission gate and an org-scoped lookup. The socket redeems the result and
 * decides nothing — which is what keeps client input out of a room name.
 *
 * The cohort is fixed at mint time from the role read on THIS request. It does
 * not go stale unnoticed: the hub re-checks every subscriber's role on an
 * interval and moves or evicts them.
 */
export default defineEventHandler(async (event) => {
  const org = requirePermission(event, 'run:read');
  const id = getRouterParam(event, 'id')!;

  // Org-scoped: another org's run is simply absent, so no grant can name it.
  const run = await createRepos(event).runs.findById(id);
  if (!run) throw createError({ statusCode: 404, statusMessage: 'Not Found' });

  const { ticket, expiresInMs } = useTicketStore().mint({
    userId: org.userId,
    orgId: org.orgId,
    runId: run.id,
    cohort: cohortFor(org.role),
  });

  return { ticket, expiresInMs, url: '/_ws/runs' };
});
