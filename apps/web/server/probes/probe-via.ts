import type { ConfiguredClass } from '../runners/runner-classes';
import type { ProbeOutcome } from './run-probe';

/** Where a Test or Preview runs: here, or on a runner of a class. */
export type ProbeVia = { readonly kind: 'web' } | { readonly kind: 'runner'; readonly runnerClass: string };

export type ViaChoice =
  | { readonly ok: true; readonly via: ProbeVia }
  | { readonly ok: false; readonly statusCode: 400 | 422; readonly message: string };

/**
 * `via` off a request body. Absent, empty or `web` is the console itself — the
 * default, and the fastest. Anything else must name a configured class, refused
 * with the same sentence a run launch would use.
 */
export function parseProbeVia(configured: readonly ConfiguredClass[], raw: unknown): ViaChoice {
  if (raw === undefined || raw === null || raw === '' || raw === 'web') return { ok: true, via: { kind: 'web' } };
  if (typeof raw !== 'string') return { ok: false, statusCode: 400, message: '"via" must be "web" or a runner class.' };
  if (!configured.some((c) => c.name === raw)) {
    return { ok: false, statusCode: 422, message: `There is no runner class "${raw}" configured.` };
  }
  return { ok: true, via: { kind: 'runner', runnerClass: raw } };
}

/** What `connections.last_test_via` records. */
export function viaLabel(via: ProbeVia): string {
  return via.kind === 'web' ? 'web' : via.runnerClass;
}

/**
 * A probe that got no answer, as an HTTP error. `no_runner` is a 503 whose
 * data the client turns into a "start a runner" offer; a timeout is a 504.
 * On an on-demand class a timeout usually means the runner is still starting —
 * the request queued the work that starts it — so it says to try again.
 */
export function probeUnanswered(
  outcome: Exclude<ProbeOutcome, { status: 'done' }>,
  runnerClass: string,
  timeoutMs: number,
  onDemand = false
): { statusCode: 503 | 504; statusMessage: string; data: { reason: 'no_runner' | 'timeout'; runnerClass: string } } {
  if (outcome.status === 'no_runner') {
    return {
      statusCode: 503,
      statusMessage: `No "${runnerClass}" runner is online to run this. Start one, or run it from the console.`,
      data: { reason: 'no_runner', runnerClass },
    };
  }
  return {
    statusCode: 504,
    statusMessage: onDemand
      ? `A "${runnerClass}" runner is being started for this: the cluster starts one on demand. Try again in a minute.`
      : `The "${runnerClass}" runner did not answer within ${Math.round(timeoutMs / 1000)}s.`,
    data: { reason: 'timeout', runnerClass },
  };
}
