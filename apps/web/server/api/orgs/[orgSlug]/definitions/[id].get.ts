import { createRepos } from '~~/server/repositories';
import { requirePermission } from '~~/server/utils/rbac';
import { indexConnections, toPublicDefinition } from '~~/server/serializers/definition.serializer';

export default defineEventHandler(async (event) => {
  requirePermission(event, 'definition:read');
  const repos = createRepos(event);

  // findById finds archived definitions too: a run links to the definition
  // that produced it, and that link must not 404 once it is retired.
  const row = await repos.definitions.findById(getRouterParam(event, 'id')!);
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Not Found' });

  const byId = indexConnections(await repos.connections.list());
  return { definition: toPublicDefinition(row, byId) };
});
