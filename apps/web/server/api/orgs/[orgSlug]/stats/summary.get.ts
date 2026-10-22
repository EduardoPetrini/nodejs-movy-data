import { createRepos } from '~~/server/repositories';
import { requirePermission } from '~~/server/utils/rbac';

/**
 * The organisation's home page, in one request.
 *
 * `stats:read`, which every role has — a viewer exists to read exactly this.
 * Nothing here names a host, a connection or a user; it is counts, percentiles
 * and two timestamps, which is why it needs no role split.
 */
export default defineEventHandler(async (event) => {
  requirePermission(event, 'stats:read');
  const windowDays = Number(getQuery(event).windowDays) || undefined;
  return { summary: await createRepos(event).stats.summary(windowDays) };
});
