import { buildRegistry, type ConnectionConfig } from '@movy/core';
import { requirePermission } from '~~/server/utils/rbac';
import { parseEngine } from '~~/server/utils/connection-config';
import { describeConnectionFailure } from '~~/server/utils/safe-error';

const TIMEOUT_MS = 10_000;

interface Body {
  engine?: string; host?: string; port?: number;
  database?: string; username?: string; password?: string; ssl?: boolean;
}

/**
 * Test credentials before they are ever saved.
 *
 * Same mechanics as `[id]/test.post.ts` — open, measure, close, describe a
 * failure as data — but there is no row yet, so nothing is persisted: no
 * `lastTest`, and the config (holding a plaintext password) never outlives
 * this request.
 */
export default defineEventHandler(async (event) => {
  requirePermission(event, 'connection:test');
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

  const registry = buildRegistry();
  const startedAt = Date.now();

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
      return { ok: true, latencyMs: Date.now() - startedAt };
    } finally {
      await connection.end().catch(() => {});
    }
  } catch (err) {
    const failure = describeConnectionFailure(err, config);
    return {
      ok: false,
      error: failure.text,
      errorKind: failure.kind,
      latencyMs: Date.now() - startedAt,
    };
  }
});
