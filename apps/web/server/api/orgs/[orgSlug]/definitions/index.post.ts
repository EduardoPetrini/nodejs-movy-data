import { randomUUID } from 'node:crypto';
import { createRepos } from '~~/server/repositories';
import { isUniqueViolation } from '~~/server/repositories/pg-errors';
import { requirePermission } from '~~/server/utils/rbac';
import { prepareDefinition } from '~~/server/definitions/prepare';
import { indexConnections, toPublicDefinition } from '~~/server/serializers/definition.serializer';

export default defineEventHandler(async (event) => {
  const org = requirePermission(event, 'definition:write');
  const { input, source, target } = await prepareDefinition(event, await readBody(event));
  const repos = createRepos(event);

  try {
    const row = await repos.definitions.create({
      id: randomUUID(),
      name: input.name,
      description: input.description,
      sourceConnectionId: input.sourceConnectionId,
      targetConnectionId: input.targetConnectionId,
      sourceDatabase: input.sourceDatabase,
      targetDatabase: input.targetDatabase,
      mode: input.mode,
      querySql: input.querySql,
      targetTableName: input.targetTableName,
      createdByUserId: org.userId,
    });

    setResponseStatus(event, 201);
    return { definition: toPublicDefinition(row, indexConnections([source, target])) };
  } catch (err) {
    // The unique index is partial on `archived_at IS NULL`, so this can only
    // mean a LIVE definition already holds the name — which is exactly what
    // the message should say, rather than a 500 quoting the failing SQL.
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
