import { randomUUID } from 'node:crypto';
import { createRepos } from '~~/server/repositories';
import { requirePermission } from '~~/server/utils/rbac';
import { toPublicConnection } from '~~/server/serializers/connection.serializer';
import { encryptSecret, secretAad } from '~~/server/utils/crypto';
import { parseEngine } from '~~/server/utils/connection-config';

interface Body {
  name?: string; engine?: string; host?: string; port?: number;
  database?: string; username?: string; password?: string;
  schemaName?: string; ssl?: boolean;
}

export default defineEventHandler(async (event) => {
  const org = requirePermission(event, 'connection:write');
  const body = await readBody<Body>(event);

  for (const field of ['name', 'engine', 'host', 'database', 'username', 'password'] as const) {
    if (!body?.[field]) throw createError({ statusCode: 400, statusMessage: `"${field}" is required.` });
  }
  if (!Number.isInteger(body.port) || body.port! < 1 || body.port! > 65535) {
    throw createError({ statusCode: 400, statusMessage: '"port" must be a valid port number.' });
  }
  parseEngine(body.engine!);

  // The id is generated here, before insert, because it is bound into the
  // secret's additional authenticated data.
  const id = randomUUID();
  const created = await createRepos(event).connections.create({
    id,
    name: body.name!.trim(),
    engine: body.engine!.toLowerCase(),
    host: body.host!.trim(),
    port: body.port!,
    database: body.database!.trim(),
    username: body.username!.trim(),
    secret: encryptSecret(body.password!, secretAad(org.orgId, id)),
    schemaName: body.schemaName?.trim() || 'public',
    ssl: body.ssl ?? false,
    createdByUserId: org.userId,
  });

  setResponseStatus(event, 201);
  return { connection: toPublicConnection(created, org.role) };
});
