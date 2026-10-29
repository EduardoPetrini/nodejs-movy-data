import type { ConnectionConfig } from '@movy/core';
import {
  PreviewConnectionError, inspectForPreview, type PreviewInspection, type PreviewProbeResult,
} from '@movy/runner/probes';
import { useMetaSql, useProbeWaiters, useProbeWorker } from '../runs';
import { probeUnanswered, type ProbeVia } from './probe-via';
import { runProbe } from './run-probe';
import { useProvisioner } from '../runners/use-provisioner';

/** A preview inspects two whole schemas; a large one takes a while. */
export const PREVIEW_PROBE_TIMEOUT_MS = 60_000;

/**
 * Both schemas, the diff, the plan and the estimates — inspected here or on a
 * runner, as `via` says. The same shape either way, so `buildPreview` and the
 * review screen cannot tell the two apart.
 *
 * An end that cannot be reached is a 502 naming which end and what kind of
 * failure, from either path; the sentence comes from the same executor.
 */
export async function inspectPreviewVia(
  orgId: string,
  source: ConnectionConfig,
  target: ConnectionConfig,
  via: ProbeVia
): Promise<PreviewInspection> {
  if (via.kind === 'web') {
    try {
      return await inspectForPreview(source, target);
    } catch (err) {
      if (err instanceof PreviewConnectionError) throw unreachable(err.side, source, target, err.errorKind, err.text);
      throw err;
    }
  }

  const onDemand = useProvisioner().isOnDemand(via.runnerClass);
  const outcome = await runProbe<PreviewProbeResult>(
    { sql: useMetaSql(), waiters: useProbeWaiters(), wake: () => void useProbeWorker()?.wake() },
    { orgId, runnerClass: via.runnerClass, request: { kind: 'preview', source, target }, timeoutMs: PREVIEW_PROBE_TIMEOUT_MS, onDemand }
  );
  if (outcome.status !== 'done') {
    throw createError(probeUnanswered(outcome, via.runnerClass, PREVIEW_PROBE_TIMEOUT_MS, onDemand));
  }

  const result = outcome.result;
  if (result.ok) return result.inspection;
  if (result.side) throw unreachable(result.side, source, target, result.errorKind, result.message);
  throw createError({
    statusCode: 502,
    statusMessage: `The "${via.runnerClass}" runner could not inspect the databases. ${result.message}`,
    data: { side: null, errorKind: result.errorKind },
  });
}

function unreachable(
  side: 'source' | 'destination',
  source: ConnectionConfig,
  target: ConnectionConfig,
  errorKind: string,
  text: string
) {
  const engine = side === 'source' ? source.type : target.type;
  return createError({
    statusCode: 502,
    statusMessage: `Could not reach the ${side} ${engine} database. ${text}`,
    data: { side, errorKind },
  });
}
