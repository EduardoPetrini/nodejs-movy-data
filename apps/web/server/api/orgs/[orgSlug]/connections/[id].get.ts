import { createRepos } from '~~/server/repositories';
import { requirePermission } from '~~/server/utils/rbac';
import { toPublicConnection } from '~~/server/serializers/connection.serializer';

export default defineEventHandler(async (event) => {
  const org = requirePermission(event, 'connection:read');
  const row = await createRepos(event).connections.findById(getRouterParam(event, 'id')!);
  // Another org's connection is indistinguishable from one that does not exist.
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Not Found' });
  return { connection: toPublicConnection(row, org.role) };
});
