import { requirePermission } from '~~/server/utils/rbac';
import { audienceFor } from '~~/server/runners/runner-hub';
import { useRunnersTicketStore } from '~~/server/runs';

/**
 * Mints a one-shot ticket for this org's runner availability.
 *
 * Every decision the socket relies on is made here, on an ordinary request:
 * the org from the URL as `02.org` resolved it, the audience from the role read
 * on this request. The socket redeems the result and decides nothing. Any
 * member may watch; only an admin's grant shows runner ids.
 */
export default defineEventHandler((event) => {
  const org = requirePermission(event, 'run:read');
  const { ticket, expiresInMs } = useRunnersTicketStore().mint({
    userId: org.userId,
    orgId: org.orgId,
    audience: audienceFor(org.role),
  });
  return { ticket, expiresInMs, url: '/_ws/runners' };
});
