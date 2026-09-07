import { buildRegistry } from '@movy/core';
import { createRepos } from '~~/server/repositories';
import { requirePermission } from '~~/server/utils/rbac';
import { toConnectionConfig } from '~~/server/utils/connection-config';

/**
 * List the databases on the server this connection points at.
 *
 * Connects to the engine's admin database (postgres / mysql / master), so it
 * only works when the credentials have that access — hence the 403-shaped
 * message rather than a bare failure.
 */
export default defineEventHandler(async (event) => {
  requirePermission(event, 'connection:read');
  const row = await createRepos(event).connections.findById(getRouterParam(event, 'id')!);
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Not Found' });

  const adapters = buildRegistry().get(toConnectionConfig(row).type);
  if (!adapters.listDatabases) {
    throw createError({ statusCode: 501, statusMessage: `Listing databases is not supported for ${row.engine}.` });
  }

  const connection = adapters.createConnection(toConnectionConfig(row, adapters.adminDatabase));
  try {
    await connection.connect();
    return { databases: await adapters.listDatabases(connection) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw createError({
      statusCode: 502,
      statusMessage: `Could not list databases: ${message}. The credentials may lack access to the "${adapters.adminDatabase}" database.`,
    });
  } finally {
    await connection.end().catch(() => {});
  }
});
