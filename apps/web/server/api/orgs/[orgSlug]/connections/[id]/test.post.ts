import { buildRegistry } from '@movy/core';
import { createRepos } from '~~/server/repositories';
import { requirePermission } from '~~/server/utils/rbac';
import { toConnectionConfig } from '~~/server/utils/connection-config';

const TIMEOUT_MS = 10_000;

/**
 * Open a connection, measure the round trip, close it.
 *
 * Failures are reported as data rather than thrown: a bad password is a normal
 * outcome of pressing Test, not a server error.
 */
export default defineEventHandler(async (event) => {
  requirePermission(event, 'connection:test');
  const repos = createRepos(event);
  const id = getRouterParam(event, 'id')!;

  const row = await repos.connections.findById(id);
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Not Found' });

  const registry = buildRegistry();
  const startedAt = Date.now();

  try {
    const adapters = registry.get(toConnectionConfig(row).type);
    const connection = adapters.createConnection(toConnectionConfig(row));
    try {
      await Promise.race([
        connection.connect(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS)
        ),
      ]);
      const latencyMs = Date.now() - startedAt;
      await repos.connections.recordTest(id, { ok: true, latencyMs });
      return { ok: true, latencyMs };
    } finally {
      await connection.end().catch(() => {});
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await repos.connections.recordTest(id, { ok: false, error: message });
    return { ok: false, error: message, latencyMs: Date.now() - startedAt };
  }
});
