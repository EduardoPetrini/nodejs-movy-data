import { randomUUID } from 'node:crypto';
import {
  abandonProbe, enqueueProbe, probeRunnerAvailable, takeProbeResult, type ProbeKind, type SqlClient,
} from '@movy/runner/agent';
import { readProbeResult, sealProbe, type ProbeRequest, type ProbeResult } from '@movy/runner/probes';
import type { ProbeWaiters } from './probe-waiters';

export type ProbeOutcome<R extends ProbeResult = ProbeResult> =
  | { readonly status: 'done'; readonly result: R }
  | { readonly status: 'no_runner' }
  | { readonly status: 'timeout' };

export interface RunProbeInput {
  readonly orgId: string;
  readonly runnerClass: string;
  readonly request: ProbeRequest;
  /** How long the user waits for a runner to answer. */
  readonly timeoutMs: number;
}

export interface RunProbeDeps {
  readonly sql: SqlClient;
  readonly waiters: ProbeWaiters;
  /** The embedded agent's fast path; an external runner hears the NOTIFY. */
  readonly wake?: () => void;
  readonly now?: () => number;
}

/** Re-read the row at least this often, in case a notification was missed. */
const RECHECK_MS = 1_000;

/**
 * Asks a runner of `runnerClass` to run a Test or Preview, and waits for it.
 *
 * "No runner of that class" is answered at once, before anything is queued, so
 * the user is offered a runner instead of waiting out a timeout. On a timeout
 * the row is deleted: a runner still working on it then finds nothing to write
 * to, and the request holding passwords is gone either way.
 */
export async function runProbe<R extends ProbeResult>(
  deps: RunProbeDeps,
  input: RunProbeInput
): Promise<ProbeOutcome<R>> {
  const { sql, waiters } = deps;
  const now = deps.now ?? Date.now;
  if (!(await probeRunnerAvailable(sql, input.runnerClass))) return { status: 'no_runner' };

  const id = randomUUID();
  await enqueueProbe(sql, {
    id,
    orgId: input.orgId,
    kind: input.request.kind as ProbeKind,
    runnerClass: input.runnerClass,
    ciphertext: sealProbe(input.orgId, id, input.request),
    // A little longer than the wait, so the sweeper never removes a probe the
    // request is still waiting on.
    ttlMs: input.timeoutMs + 5_000,
  });
  deps.wake?.();

  const deadline = now() + input.timeoutMs;
  for (;;) {
    const stored = await takeProbeResult<unknown>(sql, id, input.orgId);
    // The caller's R follows from its own request's kind, which is what the
    // answer is read as here.
    if (stored) return { status: 'done', result: readProbeResult(input.request.kind, stored) as R };
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await waiters.next(id, Math.min(RECHECK_MS, remaining));
  }
  await abandonProbe(sql, id);
  return { status: 'timeout' };
}
