import { requirePermission } from '~~/server/utils/rbac';
import { audienceFor } from '~~/server/runners/runner-hub';
import { loadRunnersSnapshot } from '~~/server/runners/runner-summary';
import { useMetaSql } from '~~/server/runs';

/**
 * The same snapshot the runners socket sends, once. For a client that cannot
 * or need not hold a socket open; the panel uses the socket.
 */
export default defineEventHandler((event) => {
  const org = requirePermission(event, 'run:read');
  return loadRunnersSnapshot(useMetaSql(), org.orgId, { includeRunners: audienceFor(org.role) === 'admin' });
});
