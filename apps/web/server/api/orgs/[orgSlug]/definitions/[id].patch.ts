import { createRepos } from '~~/server/repositories';
import { isUniqueViolation } from '~~/server/repositories/pg-errors';
import { requirePermission } from '~~/server/utils/rbac';
import { prepareDefinition } from '~~/server/definitions/prepare';
import { indexConnections, toPublicDefinition } from '~~/server/serializers/definition.serializer';

/**
 * A full replacement of the editable fields, not a sparse patch.
 *
 * `mode` decides which other fields are required, so a partial update would
 * have to guess at the combination it was producing. The form sends the whole
 * definition; validating the whole thing is both simpler and the only way the
 * check constraint can be honoured up front.
 */
export default defineEventHandler(async (event) => {
  requirePermission(event, 'definition:write');
  const { input, source, target } = await prepareDefinition(event, await readBody(event));
  const repos = createRepos(event);
  const id = getRouterParam(event, 'id')!;

  try {
    // update() filters on `archived_at IS NULL`, so editing a retired
    // definition is a 404 rather than a quiet resurrection into a name space
    // it no longer holds.
    const row = await repos.definitions.update(id, {
      name: input.name,
      description: input.description,
      sourceConnectionId: input.sourceConnectionId,
      targetConnectionId: input.targetConnectionId,
      sourceDatabase: input.sourceDatabase,
      targetDatabase: input.targetDatabase,
      mode: input.mode,
      querySql: input.querySql,
      targetTableName: input.targetTableName,
    });
    if (!row) throw createError({ statusCode: 404, statusMessage: 'Not Found' });

    return { definition: toPublicDefinition(row, indexConnections([source, target])) };
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw createError({
        statusCode: 409,
        statusMessage: `A migration called "${input.name}" already exists.`,
        data: { field: 'name' },
      });
    }
    throw err;
  }
});
