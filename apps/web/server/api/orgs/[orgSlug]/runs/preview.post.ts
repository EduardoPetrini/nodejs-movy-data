import { buildRegistry } from '@movy/core';
import { requirePermission } from '~~/server/utils/rbac';
import { toConnectionConfig, parseEngine } from '~~/server/utils/connection-config';
import { buildPreview } from '~~/server/definitions/build-preview';
import { resolveRunTarget, type RunTargetBody } from '~~/server/runs/resolve-target';
import { useMetaSql } from '~~/server/runs';
import { listConfiguredClasses } from '~~/server/runners/runner-classes';
import { resolveProbeVia } from '~~/server/probes/connection-test';
import { inspectPreviewVia } from '~~/server/probes/preview-inspection';

interface Body extends RunTargetBody {
  /** `web` (default) or a runner class to inspect from. */
  via?: unknown;
}

/**
 * What this run would do, before it does any of it.
 *
 * Strictly read-only: it inspects both ends, diffs them and plans the copy
 * order. It creates nothing — not even the destination database, which is why
 * `targetDatabaseExists` is reported instead of being fixed silently. The
 * inspection runs here, or on a runner class when `via` names one; the review
 * screen is built from it here either way.
 *
 * Called "preview", never "dry run". A dry run implies the real thing was
 * rehearsed; this only reads schemas. Applying remains all-or-nothing with no
 * rollback, and the warnings are where that is said out loud.
 *
 * `run:execute`, not `run:read`: this opens connections to two production
 * databases using stored credentials, which is a thing only someone who could
 * have launched the run should be able to make the server do.
 */
export default defineEventHandler(async (event) => {
  const org = requirePermission(event, 'run:execute');
  const body = await readBody<Body | undefined>(event);

  const target = await resolveRunTarget(event, body);
  const choice = await resolveProbeVia(body?.via);
  if (!choice.ok) throw createError({ statusCode: choice.statusCode, statusMessage: choice.message });

  const sourceType = parseEngine(target.source.engine);
  const destType = parseEngine(target.target.engine);
  const translator = buildRegistry().getTranslator(sourceType, destType);
  const sourceConfig = toConnectionConfig(target.source, target.sourceDatabase);
  const destConfig = toConnectionConfig(target.target, target.targetDatabase);

  const inspection = await inspectPreviewVia(org.orgId, sourceConfig, destConfig, choice.via);
  const runnerClasses = await listConfiguredClasses(useMetaSql());

  return {
    preview: buildPreview({
      source: { engine: target.source.engine, database: sourceConfig.database },
      target: { engine: target.target.engine, database: destConfig.database },
      targetDatabaseExists: inspection.targetDatabaseExists,
      sourceSchema: inspection.sourceSchema,
      targetSchema: inspection.targetSchema,
      diff: inspection.diff,
      plan: inspection.plan,
      rowEstimates: new Map(inspection.rowEstimates),
      sizeEstimates: new Map(inspection.sizeEstimates),
      runnerClasses,
      translateType: (type) => translator.translateColumnType(type, sourceType, destType),
    }),
  };
});
