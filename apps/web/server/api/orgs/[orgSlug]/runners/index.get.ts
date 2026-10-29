import { requirePermission } from '~~/server/utils/rbac';
import { audienceFor } from '~~/server/runners/runner-hub';
import { loadRunnersSnapshot } from '~~/server/runners/runner-summary';
import { useMetaSql } from '~~/server/runs';
import { useProvisioner } from '~~/server/runners/use-provisioner';
import { isPlatformAdminRequest } from '~~/server/utils/require-platform-admin';

/**
 * The same snapshot the runners socket sends, once. For a client that cannot
 * or need not hold a socket open; the panel uses the socket.
 */
export default defineEventHandler(async (event) => {
  const org = requirePermission(event, 'run:read');
  return loadRunnersSnapshot(useMetaSql(), org.orgId, {
    includeRunners: audienceFor(await isPlatformAdminRequest(event)) === 'operator',
    isOnDemand: (cls) => useProvisioner().isOnDemand(cls),
  });
});
