import type { ConnectionConfig } from '@movy/core';
import { requirePermission } from '~~/server/utils/rbac';
import { parseEngine } from '~~/server/utils/connection-config';
import { testConnectionVia } from '~~/server/probes/connection-test';

interface Body {
  engine?: string; host?: string; port?: number;
  database?: string; username?: string; password?: string; ssl?: boolean;
  /** `web` (default) or a runner class to test from. */
  via?: unknown;
}

/**
 * Test credentials before they are ever saved.
 *
 * Same mechanics as `[id]/test.post.ts` — open, measure, close, describe a
 * failure as data — but there is no row yet, so nothing is persisted: no
 * `lastTest`, and the config (holding a plaintext password) never outlives
 * this request — on a runner it is sealed for the probe and cleared at claim.
 */
export default defineEventHandler(async (event) => {
  const org = requirePermission(event, 'connection:test');
  const body = await readBody<Body>(event);

  for (const field of ['engine', 'host', 'database', 'username', 'password'] as const) {
    if (!body?.[field]) throw createError({ statusCode: 400, statusMessage: `"${field}" is required.` });
  }
  if (!Number.isInteger(body.port) || body.port! < 1 || body.port! > 65535) {
    throw createError({ statusCode: 400, statusMessage: '"port" must be a valid port number.' });
  }

  const config: ConnectionConfig = {
    type: parseEngine(body.engine!),
    host: body.host!,
    port: body.port!,
    user: body.username!,
    password: body.password!,
    database: body.database!,
    ssl: body.ssl ? { rejectUnauthorized: false } : undefined,
  };

  return testConnectionVia(org.orgId, config, body.via);
});
