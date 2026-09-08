import { createRepos } from '~~/server/repositories';
import { isForeignKeyViolation } from '~~/server/repositories/pg-errors';
import { requirePermission } from '~~/server/utils/rbac';

export default defineEventHandler(async (event) => {
  requirePermission(event, 'connection:write');
  const repos = createRepos(event);
  const id = getRouterParam(event, 'id')!;

  try {
    const removed = await repos.connections.remove(id);
    if (!removed) throw createError({ statusCode: 404, statusMessage: 'Not Found' });
  } catch (err) {
    // `migration_definitions` references connections with ON DELETE restrict,
    // so the database refuses this rather than orphaning a definition. That
    // refusal is an answer the operator can act on — count the definitions and
    // say so, instead of returning a 500 quoting the constraint name.
    if (isForeignKeyViolation(err)) {
      const inUse = await repos.definitions.countUsingConnection(id);
      throw createError({
        statusCode: 409,
        statusMessage:
          inUse > 0
            ? `${inUse} saved migration${inUse === 1 ? '' : 's'} still ${inUse === 1 ? 'uses' : 'use'} this connection. Archive ${inUse === 1 ? 'it' : 'them'} first.`
            : 'Something still references this connection.',
      });
    }
    throw err;
  }

  setResponseStatus(event, 204);
  return null;
});
