import { createRepos } from '~~/server/repositories';
import { requirePermission } from '~~/server/utils/rbac';
import { toPublicValidation } from '~~/server/serializers/validation.serializer';
import { encodeCursor, decodeCursor } from '#shared/keyset-cursor';

/**
 * One page of comparison history.
 *
 * `validation:read`, which a viewer has: reading past executions and reports is
 * exactly what the role is for. Starting one is `validation:execute`, which
 * they do not have — it opens two production databases with stored credentials.
 */
export default defineEventHandler(async (event) => {
  requirePermission(event, 'validation:read');
  const query = getQuery(event);

  const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
  if (query.cursor !== undefined && !cursor) {
    throw createError({ statusCode: 400, statusMessage: 'That page cursor is not valid.' });
  }

  const page = await createRepos(event).validations.page({
    limit: Number(query.limit) || undefined,
    cursor,
    definitionId: typeof query.definitionId === 'string' ? query.definitionId : undefined,
  });

  return {
    validations: page.rows.map(toPublicValidation),
    nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
  };
});
