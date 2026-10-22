import { randomUUID } from 'node:crypto';
import { createRepos } from '~~/server/repositories';
import { requirePermission } from '~~/server/utils/rbac';
import { toConnectionConfig } from '~~/server/utils/connection-config';
import { toPublicRun } from '~~/server/serializers/run.serializer';
import { journalPathFor, simulationFixture, useRunManager } from '~~/server/runs';
import { resolveRunTarget, type RunTargetBody } from '~~/server/runs/resolve-target';

interface Body extends RunTargetBody {
  /**
   * Replay the bundled recording instead of touching a database.
   *
   * A boolean, NOT a path. An earlier version took the fixture path from the
   * body and handed it to the runner as `--simulate <path>`, which let any
   * editor name any file on the host — at best a way to probe which paths
   * exist, and an entirely unnecessary one. The server owns the path.
   */
  simulate?: boolean;
  speed?: number;
}

/** Recorded pace is 1; below this the replay outlives any reason to watch it. */
function clampSpeed(speed: unknown): number | undefined {
  if (typeof speed !== 'number' || !Number.isFinite(speed)) return undefined;
  return Math.min(50, Math.max(0.001, speed));
}

export default defineEventHandler(async (event) => {
  const org = requirePermission(event, 'run:execute');
  const body = await readBody<Body>(event);
  const repos = createRepos(event);

  // The same resolution the preview used, so the run that starts is the run
  // that was reviewed. It settles the definition, both connections, both
  // databases and the mode, and refuses an unsupported combination with the
  // sentence the form already showed.
  const target = await resolveRunTarget(event, body);

  // One noisy org must not starve another, and two concurrent runs into the
  // same destination would clear each other's tables.
  const active = await repos.runs.countActive();
  if (active >= org.maxConcurrentRuns) {
    throw createError({
      statusCode: 409,
      statusMessage: `This organization already has ${active} run(s) in progress.`,
    });
  }

  const runId = randomUUID();
  const journalPath = journalPathFor(runId);

  const run = await repos.runs.create({
    id: runId,
    definitionId: target.definition?.id ?? null,
    sourceConnectionId: target.source.id,
    targetConnectionId: target.target.id,
    // Snapshotted so history stays true after a connection is edited or deleted.
    sourceEngine: target.source.engine,
    sourceDatabase: target.sourceDatabase,
    targetEngine: target.target.engine,
    targetDatabase: target.targetDatabase,
    mode: target.mode,
    status: 'queued',
    simulated: Boolean(body?.simulate),
    journalPath,
    requestedByUserId: org.userId,
  });

  // The two decryptions happen here and the result goes straight onto the
  // child's stdin. It is never logged, never stored, and never in argv.
  useRunManager().launch({
    runId,
    journalPath,
    spec: {
      runId,
      // `resolveRunTarget` has already refused every mode the runner cannot
      // drive, so this asserts a decision rather than making one.
      mode: 'full',
      source: toConnectionConfig(target.source, target.sourceDatabase),
      target: toConnectionConfig(target.target, target.targetDatabase),
    },
    simulateFixture: body?.simulate ? simulationFixture() : undefined,
    // Clamped: the runner rejects a non-positive speed, but a 1e-9 would
    // schedule a replay measured in centuries and hold a process open.
    speed: clampSpeed(body?.speed),
  });

  setResponseStatus(event, 201);
  return { run: toPublicRun(run, org.role) };
});
