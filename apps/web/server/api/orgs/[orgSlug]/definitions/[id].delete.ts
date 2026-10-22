import { createRepos } from '~~/server/repositories';
import { requirePermission } from '~~/server/utils/rbac';

/**
 * Retires a definition; it is never actually deleted.
 *
 * Runs point at the definition that produced them, and that attribution is the
 * only thing tying a year of history to one migration. Archiving keeps it and
 * still takes the row out of every list, which is what the operator asked for.
 * The name is freed for reuse because the unique index is partial.
 */
export default defineEventHandler(async (event) => {
  requirePermission(event, 'definition:write');
  const archived = await createRepos(event).definitions.archive(getRouterParam(event, 'id')!);
  // Already archived, or never existed, or another org's — all indistinguishable
  // here, and all correctly 404.
  if (!archived) throw createError({ statusCode: 404, statusMessage: 'Not Found' });

  setResponseStatus(event, 204);
  return null;
});
