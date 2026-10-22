import { createRepos } from '~~/server/repositories';
import { requirePermission } from '~~/server/utils/rbac';
import { toPublicRun } from '~~/server/serializers/run.serializer';
import { useRunManager } from '~~/server/runs';

/**
 * Cancellation is cooperative: the orchestrator observes the abort at a step
 * boundary and between tables, so `cancelling` is a real state the client sees
 * for a while. An in-flight COPY or CREATE INDEX cannot be interrupted from
 * Node, and pretending otherwise would be the lie.
 */
export default defineEventHandler(async (event) => {
  const org = requirePermission(event, 'run:cancel');
  const repos = createRepos(event);
  const id = getRouterParam(event, 'id')!;

  const run = await repos.runs.findById(id);
  if (!run) throw createError({ statusCode: 404, statusMessage: 'Not Found' });

  // Marked before signalling: if the signal is lost, the UI still shows the
  // request was accepted, and the reverse order could signal a run whose row
  // says nothing happened.
  const updated = await repos.runs.requestCancel(id, org.userId);
  if (!updated) return { run: toPublicRun(run, org.role), signalled: false, alreadyFinished: true };

  const signalled = await useRunManager().cancel(id, run.pid);
  return { run: toPublicRun(updated, org.role), signalled, alreadyFinished: false };
});
