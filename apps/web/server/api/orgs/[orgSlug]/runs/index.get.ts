import { createRepos } from '~~/server/repositories';
import { requirePermission } from '~~/server/utils/rbac';
import { toPublicRun } from '~~/server/serializers/run.serializer';

export default defineEventHandler(async (event) => {
  const org = requirePermission(event, 'run:read');
  const limit = Math.min(Number(getQuery(event).limit) || 50, 200);
  const rows = await createRepos(event).runs.list(limit);
  return { runs: rows.map((row) => toPublicRun(row, org.role)) };
});
