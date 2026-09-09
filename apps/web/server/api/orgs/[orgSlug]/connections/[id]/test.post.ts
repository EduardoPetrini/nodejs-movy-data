import { buildRegistry } from '@movy/core';
import { createRepos } from '~~/server/repositories';
import { requirePermission } from '~~/server/utils/rbac';
import { toConnectionConfig } from '~~/server/utils/connection-config';
import { describeConnectionFailure } from '~~/server/utils/safe-error';

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
  // Held so the failure path can strip this connection's own password out of
  // whatever the driver says. recordTest() persists that message and
  // toPublicConnection serves it to viewers, so an unscrubbed driver error here
  // is a credential disclosure with a long shelf life.
  const config = toConnectionConfig(row);

  try {
    const adapters = registry.get(config.type);
    const connection = adapters.createConnection(config);
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
    const failure = describeConnectionFailure(err, config);
    await repos.connections.recordTest(id, { ok: false, error: failure.text });
    return {
      ok: false,
      error: failure.text,
      errorKind: failure.kind,
      latencyMs: Date.now() - startedAt,
    };
  }
});
