import { requirePermission } from '~~/server/utils/rbac';
import { useMetaSql } from '~~/server/runs';
import { UnknownRunnerClassError, loadClassCapacity } from '~~/server/runners/provisioner';
import { useProvisioner } from '~~/server/runners/use-provisioner';
import { DockerEngineError } from '~~/server/runners/docker-engine';
import { NoRunnerTemplateError } from '~~/server/runners/docker-provisioner';
import type { ScaleResult } from '#shared/runner-wire';

/**
 * "Start a runner": one more runner of a class, up to its `max_replicas`.
 *
 * Admins only (`runner:scale`): runners are shared by every org, so this
 * starts infrastructure beyond the org it was asked from. Under the manual
 * provisioner nothing starts, and the answer is the command that would.
 */
export default defineEventHandler(async (event): Promise<ScaleResult> => {
  requirePermission(event, 'runner:scale');
  const body = await readBody<{ runnerClass?: unknown }>(event).catch(() => undefined);
  const runnerClass = body?.runnerClass;
  if (typeof runnerClass !== 'string' || runnerClass.length === 0 || runnerClass.length > 63) {
    throw createError({ statusCode: 400, statusMessage: '"runnerClass" must name a runner class.' });
  }

  try {
    const capacity = await loadClassCapacity(useMetaSql(), runnerClass);
    return await useProvisioner().scaleUp(capacity);
  } catch (err) {
    if (err instanceof UnknownRunnerClassError) throw createError({ statusCode: 404, statusMessage: err.message });
    // The engine's own sentence — a missing image, an unreachable socket — is
    // what the admin needs, and it names infrastructure, never a credential.
    if (err instanceof DockerEngineError || err instanceof NoRunnerTemplateError) {
      throw createError({ statusCode: 502, statusMessage: err.message });
    }
    console.error('[runners] scale failed:', err instanceof Error ? err.message : err);
    throw createError({ statusCode: 502, statusMessage: 'The runner could not be started.' });
  }
});
