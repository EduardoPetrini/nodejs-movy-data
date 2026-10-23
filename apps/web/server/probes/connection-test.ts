import type { ConnectionConfig } from '@movy/core';
import { testConnection, type ConnectionTestResult } from '@movy/runner/probes';
import { useMetaSql, useProbeWaiters, useProbeWorker } from '../runs';
import { listConfiguredClasses } from '../runners/runner-classes';
import { parseProbeVia, probeUnanswered, viaLabel } from './probe-via';
import { runProbe } from './run-probe';

/** The wait for a runner's answer: the 10 s connect timeout, plus the round trip. */
export const TEST_PROBE_TIMEOUT_MS = 15_000;

/**
 * Test a connection here or from a runner class, as `via` says, and return the
 * same result shape either way. Throws the 400/422 for a bad `via`, and the
 * 503/504 for a runner that is absent or silent.
 */
export async function testConnectionVia(
  orgId: string,
  config: ConnectionConfig,
  rawVia: unknown
): Promise<ConnectionTestResult & { via: string }> {
  const choice = await resolveProbeVia(rawVia);
  if (!choice.ok) throw createError({ statusCode: choice.statusCode, statusMessage: choice.message });
  const { via } = choice;

  if (via.kind === 'web') return { ...(await testConnection(config)), via: 'web' };

  const outcome = await runProbe<ConnectionTestResult>(
    { sql: useMetaSql(), waiters: useProbeWaiters(), wake: () => void useProbeWorker()?.wake() },
    { orgId, runnerClass: via.runnerClass, request: { kind: 'test', config }, timeoutMs: TEST_PROBE_TIMEOUT_MS }
  );
  if (outcome.status !== 'done') throw createError(probeUnanswered(outcome, via.runnerClass, TEST_PROBE_TIMEOUT_MS));
  return { ...outcome.result, via: viaLabel(via) };
}

/** `via` checked against the configured classes, read only when one is named. */
export async function resolveProbeVia(rawVia: unknown): Promise<ReturnType<typeof parseProbeVia>> {
  const isWeb = rawVia === undefined || rawVia === null || rawVia === '' || rawVia === 'web';
  return parseProbeVia(isWeb ? [] : await listConfiguredClasses(useMetaSql()), rawVia);
}
