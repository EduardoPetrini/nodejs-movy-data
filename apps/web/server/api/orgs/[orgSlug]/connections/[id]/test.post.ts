import { createRepos } from '~~/server/repositories';
import { requirePermission } from '~~/server/utils/rbac';
import { toConnectionConfig } from '~~/server/utils/connection-config';
import { testConnectionVia } from '~~/server/probes/connection-test';

/**
 * Open a connection, measure the round trip, close it — here, or from a
 * runner class when the body says `via: '<class>'`.
 *
 * Failures are reported as data rather than thrown: a bad password is a normal
 * outcome of pressing Test, not a server error. Either way the outcome is
 * recorded with where it ran, because "works from web, fails from `large`" is
 * the diagnosis testing from a runner exists for.
 */
export default defineEventHandler(async (event) => {
  const org = requirePermission(event, 'connection:test');
  const repos = createRepos(event);
  const id = getRouterParam(event, 'id')!;
  const body = await readBody<{ via?: unknown } | undefined>(event);

  const row = await repos.connections.findById(id);
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Not Found' });

  // The failure message is scrubbed of this connection's own password by the
  // executor. recordTest() persists it and toPublicConnection serves it to
  // viewers, so an unscrubbed driver error here is a credential disclosure
  // with a long shelf life.
  const result = await testConnectionVia(org.orgId, toConnectionConfig(row), body?.via);

  await repos.connections.recordTest(id, {
    ok: result.ok,
    latencyMs: result.ok ? result.latencyMs : undefined,
    error: result.error,
    via: result.via,
  });
  return result;
});
