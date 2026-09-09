import { buildRegistry } from '@movy/core';
import { createRepos } from '~~/server/repositories';
import { requirePermission } from '~~/server/utils/rbac';
import { toConnectionConfig } from '~~/server/utils/connection-config';
import { describeConnectionFailure } from '~~/server/utils/safe-error';

export default defineEventHandler(async (event) => {
  requirePermission(event, 'connection:read');
  const row = await createRepos(event).connections.findById(getRouterParam(event, 'id')!);
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Not Found' });

  const query = getQuery(event);
  const database = typeof query.database === 'string' ? query.database : undefined;
  const schema = typeof query.schema === 'string' ? query.schema : row.schemaName;

  const adapters = buildRegistry().get(toConnectionConfig(row).type);
  if (!adapters.listTables) {
    throw createError({ statusCode: 501, statusMessage: `Listing tables is not supported for ${row.engine}.` });
  }

  const config = toConnectionConfig(row, database);
  const connection = adapters.createConnection(config);
  try {
    await connection.connect();
    return { tables: await adapters.listTables(connection, { database, schema }) };
  } catch (err) {
    const failure = describeConnectionFailure(err, config);
    throw createError({
      statusCode: 502,
      statusMessage: `Could not list tables. ${failure.text}`,
      data: { errorKind: failure.kind },
    });
  } finally {
    await connection.end().catch(() => {});
  }
});
