import { createRepos } from '~~/server/repositories';
import { requirePermission } from '~~/server/utils/rbac';
import { toPublicConnection } from '~~/server/serializers/connection.serializer';

export default defineEventHandler(async (event) => {
  const org = requirePermission(event, 'connection:read');
  const repos = createRepos(event);
  const rows = await repos.connections.list();
  return { connections: rows.map((row) => toPublicConnection(row, org.role)) };
});
