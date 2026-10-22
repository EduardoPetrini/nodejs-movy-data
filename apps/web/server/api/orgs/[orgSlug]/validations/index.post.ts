import { randomUUID } from 'node:crypto';
import {
  ConsoleLogger, ValidateCountsUseCase, buildRegistry,
  type ConnectionConfig, type IDatabaseConnection,
} from '@movy/core';
import { createRepos } from '~~/server/repositories';
import { requirePermission } from '~~/server/utils/rbac';
import { parseEngine, toConnectionConfig } from '~~/server/utils/connection-config';
import { resolveRunTarget, type RunTargetBody } from '~~/server/runs/resolve-target';
import { toPublicValidationDetail } from '~~/server/serializers/validation.serializer';
import { describeConnectionFailure, safeErrorMessage } from '~~/server/utils/safe-error';

/**
 * Count every table on both sides and record the answer.
 *
 * Synchronous, unlike a run: this opens two connections, issues one `COUNT(*)`
 * per table and closes them. There is no child process, no journal and no
 * event stream, because there is nothing to watch — a comparison has one
 * moment, and it is the end.
 *
 * The row is written BEFORE the counting starts, so a comparison that fails
 * halfway is a `failed` row naming the reason rather than nothing at all. A
 * comparison that produced no record is indistinguishable from one nobody ran.
 *
 * Resolved through `resolveRunTarget`, the same function preview and launch
 * use, so "compare what I just migrated" names the two databases the migration
 * actually used — not a second, hand-assembled idea of them.
 */
export default defineEventHandler(async (event) => {
  const org = requirePermission(event, 'validation:execute');
  const body = (await readBody(event)) as (RunTargetBody & { runId?: unknown }) | undefined;
  const repos = createRepos(event);

  // checkMode: false — a comparison runs no migration, so the launch gate does
  // not apply. Query mode is refused here instead, with the reason that is
  // actually true of a comparison.
  const target = await resolveRunTarget(event, body, { checkMode: false });
  if (target.mode === 'query') {
    throw createError({
      statusCode: 422,
      statusMessage:
        'A query migration writes one table, so comparing every table in the source against ' +
        'the destination would report all the others as missing. Compare the two databases directly instead.',
    });
  }

  // An org-scoped lookup, so a run id from another org is simply absent and the
  // comparison is recorded with no run attached rather than pointed at one the
  // caller cannot see.
  const runId =
    typeof body?.runId === 'string' && (await repos.runs.findById(body.runId)) ? body.runId : null;

  const sourceType = parseEngine(target.source.engine);
  const destType = parseEngine(target.target.engine);
  const registry = buildRegistry();

  const sourceConfig = toConnectionConfig(target.source, target.sourceDatabase);
  const destConfig = toConnectionConfig(target.target, target.targetDatabase);

  const validation = await repos.validations.create({
    id: randomUUID(),
    runId,
    definitionId: target.definition?.id ?? null,
    sourceConnectionId: target.source.id,
    targetConnectionId: target.target.id,
    sourceEngine: target.source.engine,
    sourceDatabase: sourceConfig.database,
    targetEngine: target.target.engine,
    targetDatabase: destConfig.database,
    status: 'running',
    requestedByUserId: org.userId,
  });

  const sourceConnection = registry.get(sourceType).createConnection(sourceConfig);
  const destConnection = registry.get(destType).createConnection(destConfig);
  const open: IDatabaseConnection[] = [];
  const startedAt = Date.now();

  try {
    await connectOrFail(sourceConnection, 'source', target.source.engine, sourceConfig);
    open.push(sourceConnection);
    await connectOrFail(destConnection, 'destination', target.target.engine, destConfig);
    open.push(destConnection);

    // A real logger, so a failing comparison leaves a trace in the server log.
    // `ValidateCountsUseCase` prints its whole table through this; none of it
    // reaches the client, which reads the stored rows instead.
    const result = await new ValidateCountsUseCase(new ConsoleLogger('compare')).execute(
      sourceConnection,
      destConnection,
      { type: sourceType, database: sourceConfig.database },
      { type: destType, database: destConfig.database }
    );

    await repos.validations.complete(
      validation.id,
      {
        totalSource: result.totalSource,
        totalDest: result.totalDest,
        totalMatchPct: result.totalMatchPct,
        allMatch: result.allMatch,
        tablesCompared: result.tables.length,
        tablesMismatched: result.tables.filter((t) => t.matchPct < 100).length,
        durationMs: Date.now() - startedAt,
      },
      result.tables
    );
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    // Settled as `failed` before rethrowing, so the record says what happened
    // even though the caller also gets the error.
    await repos.validations.fail(
      validation.id,
      // Stored, and later served to viewers, so it is scrubbed of both
      // passwords first — a COUNT(*) that fails mid-comparison raises the same
      // driver errors the connect path does.
      { name: error.name, message: safeErrorMessage(error, sourceConfig, destConfig) },
      Date.now() - startedAt
    );
    throw err;
  } finally {
    await Promise.all(open.map((connection) => connection.end().catch(() => {})));
  }

  const stored = await repos.validations.findById(validation.id);
  if (!stored) throw createError({ statusCode: 500, statusMessage: 'Comparison vanished' });

  setResponseStatus(event, 201);
  return { validation: toPublicValidationDetail(stored, await repos.validations.tableCounts(validation.id)) };
});

/**
 * Connect, or turn the driver's error into a 502 naming which end failed.
 *
 * Which end is the diagnosis: "could not reach the destination" sends the
 * operator to a different screen than "could not reach the source". The same
 * shape `runs/preview.post.ts` uses, for the same reason — including passing
 * the config so the driver's words can have the password taken out of them.
 */
async function connectOrFail(
  connection: IDatabaseConnection,
  side: 'source' | 'destination',
  engine: string,
  config: ConnectionConfig
): Promise<void> {
  try {
    await connection.connect();
  } catch (err) {
    const failure = describeConnectionFailure(err, config);
    throw createError({
      statusCode: 502,
      statusMessage: `Could not reach the ${side} ${engine} database. ${failure.text}`,
      data: { side, errorKind: failure.kind },
    });
  }
}
