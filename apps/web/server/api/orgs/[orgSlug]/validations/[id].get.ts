import { createRepos } from '~~/server/repositories';
import { requirePermission } from '~~/server/utils/rbac';
import { toPublicValidationDetail } from '~~/server/serializers/validation.serializer';

/** One comparison in full, with its per-table counts. */
export default defineEventHandler(async (event) => {
  requirePermission(event, 'validation:read');
  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing id' });

  const repos = createRepos(event);
  const found = await repos.validations.findById(id);
  // Another org's comparison and one that never existed give the same answer.
  if (!found) throw createError({ statusCode: 404, statusMessage: 'Not Found' });

  const tables = await repos.validations.tableCounts(id);
  return { validation: toPublicValidationDetail(found, tables) };
});
