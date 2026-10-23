import { createRepos } from '~~/server/repositories';
import { requirePermission } from '~~/server/utils/rbac';
import { toPublicRun } from '~~/server/serializers/run.serializer';
import { useRunnerAgent } from '~~/server/runs';

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

  // Not claimed yet: cancelled outright, and no runner will ever see it. The
  // statement is conditional on `queued`, so it cannot race a claim.
  const cancelledQueued = await repos.runs.cancelQueued(id, org.userId);
  if (cancelledQueued) return { run: toPublicRun(cancelledQueued, org.role), signalled: true, alreadyFinished: false };

  // Marked before signalling: if the signal is lost, the UI still shows the
  // request was accepted, and the owning runner's next heartbeat finds the
  // `cancelling` row and forwards the cancel itself.
  const updated = await repos.runs.requestCancel(id, org.userId);
  if (!updated) return { run: toPublicRun(run, org.role), signalled: false, alreadyFinished: true };

  // The fast path, when the run is on this host's embedded agent.
  const agent = useRunnerAgent();
  const signalled = agent ? await agent.cancel(id, run.pid) : false;
  return { run: toPublicRun(updated, org.role), signalled, alreadyFinished: false };
});
