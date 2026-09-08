import { createRepos } from '~~/server/repositories';
import { requirePermission } from '~~/server/utils/rbac';
import { indexConnections, toPublicDefinition } from '~~/server/serializers/definition.serializer';

/**
 * Every saved migration in this org.
 *
 * `definition:read`, so a viewer sees the list: what this org migrates is the
 * shape of its history, and a viewer is entitled to that. The serializer keeps
 * hosts and credentials out of it.
 */
export default defineEventHandler(async (event) => {
  requirePermission(event, 'definition:read');
  const repos = createRepos(event);

  // Both reads are org-scoped and independent, so they overlap rather than
  // queue. The connections are needed only to name the endpoints.
  const [rows, connections] = await Promise.all([
    repos.definitions.list(),
    repos.connections.list(),
  ]);

  const byId = indexConnections(connections);
  return { definitions: rows.map((row) => toPublicDefinition(row, byId)) };
});
