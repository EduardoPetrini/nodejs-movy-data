import { createRepos } from '~~/server/repositories';
import { requirePermission } from '~~/server/utils/rbac';
import { toPublicRun, toPublicStep, toPublicTableProgress } from '~~/server/serializers/run.serializer';

/** The whole current state of one run, from the projections — never a fold over events. */
export default defineEventHandler(async (event) => {
  const org = requirePermission(event, 'run:read');
  const repos = createRepos(event);
  const id = getRouterParam(event, 'id')!;

  const run = await repos.runs.findById(id);
  if (!run) throw createError({ statusCode: 404, statusMessage: 'Not Found' });

  const [steps, tables] = await Promise.all([repos.runs.steps(id), repos.runs.tableProgress(id)]);

  return {
    run: toPublicRun(run, org.role),
    steps: steps.map(toPublicStep),
    tables: tables.map(toPublicTableProgress),
  };
});
