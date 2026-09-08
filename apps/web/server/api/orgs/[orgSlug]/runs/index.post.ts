import { randomUUID } from 'node:crypto';
import { buildRegistry } from '@movy/core';
import { createRepos } from '~~/server/repositories';
import { requirePermission } from '~~/server/utils/rbac';
import { toConnectionConfig, parseEngine } from '~~/server/utils/connection-config';
import { toPublicRun } from '~~/server/serializers/run.serializer';
import { journalPathFor, useRunManager } from '~~/server/runs';

interface Body {
  sourceConnectionId?: string;
  targetConnectionId?: string;
  /** Override the connection's own database, as the CLI prompt does. */
  sourceDatabase?: string;
  targetDatabase?: string;
  /** Replay a recorded journal instead of touching a database. */
  simulateFixture?: string;
  speed?: number;
}

export default defineEventHandler(async (event) => {
  const org = requirePermission(event, 'run:execute');
  const body = await readBody<Body>(event);
  const repos = createRepos(event);

  for (const field of ['sourceConnectionId', 'targetConnectionId'] as const) {
    if (!body?.[field]) throw createError({ statusCode: 400, statusMessage: `"${field}" is required.` });
  }

  // findById is org-scoped, so a connection id from another org is simply
  // absent here — the run cannot be pointed at it.
  const source = await repos.connections.findById(body.sourceConnectionId!);
  const target = await repos.connections.findById(body.targetConnectionId!);
  if (!source || !target) throw createError({ statusCode: 404, statusMessage: 'Not Found' });

  // Refusing an unsupported Pair here rather than at run time: a run row that
  // exists only to fail on its first step is noise in the history.
  const pair = { from: parseEngine(source.engine), to: parseEngine(target.engine) };
  const registry = buildRegistry();
  if (!registry.has(pair.from) || !registry.has(pair.to)) {
    throw createError({ statusCode: 400, statusMessage: 'That engine pair is not supported.' });
  }

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
  const sourceDatabase = body.sourceDatabase?.trim() || source.database;
  const targetDatabase = body.targetDatabase?.trim() || target.database;

  const run = await repos.runs.create({
    id: runId,
    sourceConnectionId: source.id,
    targetConnectionId: target.id,
    // Snapshotted so history stays true after a connection is edited or deleted.
    sourceEngine: source.engine,
    sourceDatabase,
    targetEngine: target.engine,
    targetDatabase,
    mode: 'full',
    status: 'queued',
    simulated: Boolean(body.simulateFixture),
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
      mode: 'full',
      source: toConnectionConfig(source, sourceDatabase),
      target: toConnectionConfig(target, targetDatabase),
    },
    simulateFixture: body.simulateFixture,
    speed: body.speed,
  });

  setResponseStatus(event, 201);
  return { run: toPublicRun(run, org.role) };
});
