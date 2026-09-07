import { createRepos } from '~~/server/repositories';
import { requirePermission } from '~~/server/utils/rbac';

export default defineEventHandler(async (event) => {
  requirePermission(event, 'connection:write');
  const removed = await createRepos(event).connections.remove(getRouterParam(event, 'id')!);
  if (!removed) throw createError({ statusCode: 404, statusMessage: 'Not Found' });
  setResponseStatus(event, 204);
  return null;
});
