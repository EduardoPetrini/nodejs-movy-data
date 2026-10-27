import { randomUUID } from 'node:crypto';
import { createRepos } from '~~/server/repositories';
import { requirePermission } from '~~/server/utils/rbac';
import { toConnectionConfig } from '~~/server/utils/connection-config';
import { toPublicRun } from '~~/server/serializers/run.serializer';
import { sealRunSpec } from '@movy/runner/agent';
import { assertSimulationAvailable, useMetaSql, useRunnerAgent } from '~~/server/runs';
import { chooseRunnerClass, listConfiguredClasses } from '~~/server/runners/runner-classes';
import { resolveRunTarget, type RunTargetBody } from '~~/server/runs/resolve-target';
import { targetLockKey } from '~~/server/runs/target-lock';

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
  /**
   * The runner class to queue for. Unlike the rest of a definition, the review
   * screen may override it: a bigger runner does not change WHAT runs.
   */
  runnerClass?: string;
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

  if (body?.simulate) assertSimulationAvailable();

  const choice = chooseRunnerClass(
    await listConfiguredClasses(useMetaSql()),
    body?.runnerClass,
    target.definition?.runnerClass ?? null
  );
  if (!choice.ok) throw createError({ statusCode: choice.statusCode, statusMessage: choice.message });

  const runId = randomUUID();

  // The two decryptions happen here, and the spec is sealed again at once for
  // this org and this run: the runner that claims it decrypts it, deletes it,
  // and hands it straight to the child's stdin. It is never logged and never
  // in argv. Sealed at enqueue so the run that starts is the run that was
  // reviewed, whenever and wherever it is claimed.
  const sealed = sealRunSpec(
    org.orgId,
    runId,
    body?.simulate
      ? // Clamped: the runner rejects a non-positive speed, but a 1e-9 would
        // schedule a replay measured in centuries and hold a process open.
        { simulate: true, speed: clampSpeed(body?.speed) }
      : {
          simulate: false,
          spec: {
            runId,
            // `resolveRunTarget` has already refused every mode the runner
            // cannot drive, so this asserts a decision rather than making one.
            mode: 'full',
            source: toConnectionConfig(target.source, target.sourceDatabase),
            target: toConnectionConfig(target.target, target.targetDatabase),
          },
        }
  );

  const run = await repos.runs.enqueue(
    {
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
      simulated: Boolean(body?.simulate),
      runnerClass: choice.runnerClass,
      // One run per destination, across orgs: the claim waits while another
      // run holds it. A replay writes nowhere, so it locks nothing.
      targetLockKey: body?.simulate
        ? null
        : targetLockKey({
            engine: target.target.engine,
            host: target.target.host,
            port: target.target.port,
            database: target.targetDatabase,
          }),
      requestedByUserId: org.userId,
    },
    sealed
  );

  // The fast path. Without an embedded agent, a runner's poll finds it.
  void useRunnerAgent()?.wake();

  setResponseStatus(event, 201);
  return { run: toPublicRun(run, org.role) };
});
