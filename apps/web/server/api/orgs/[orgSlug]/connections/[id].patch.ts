import { createRepos } from '~~/server/repositories';
import { requirePermission } from '~~/server/utils/rbac';
import { toPublicConnection } from '~~/server/serializers/connection.serializer';
import { encryptSecret, secretAad } from '~~/server/utils/crypto';

export default defineEventHandler(async (event) => {
  const org = requirePermission(event, 'connection:write');
  const id = getRouterParam(event, 'id')!;
  const body = await readBody<Record<string, unknown>>(event);

  const repos = createRepos(event);
  if (!(await repos.connections.findById(id))) {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' });
  }

  const patch: Record<string, unknown> = {};
  for (const field of ['name', 'host', 'database', 'username', 'schemaName'] as const) {
    if (typeof body[field] === 'string') patch[field] = (body[field] as string).trim();
  }
  if (Number.isInteger(body.port)) patch.port = body.port;
  if (typeof body.ssl === 'boolean') patch.ssl = body.ssl;

  // Omitted or blank password means "keep the current one" — the form shows a
  // placeholder, never the stored value.
  if (typeof body.password === 'string' && body.password.length > 0) {
    patch.secret = encryptSecret(body.password, secretAad(org.orgId, id));
  }

  const updated = await repos.connections.update(id, patch);
  if (!updated) throw createError({ statusCode: 404, statusMessage: 'Not Found' });
  return { connection: toPublicConnection(updated, org.role) };
});
