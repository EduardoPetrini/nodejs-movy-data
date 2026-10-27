/**
 * Postgres LISTEN/NOTIFY channels: the bus between runner agents and the web
 * consoles (docs/runner-service-plan.md, phase 3). Named once, so a sender and
 * a listener cannot drift apart by a typo.
 *
 * Every payload is a pointer, never data: NOTIFY caps payloads at 8 KB, and the
 * data is already in a table the receiver reads.
 */

/** `{runId, lastSeq}` — sent in the same transaction that stored the events. */
export const RUN_EVENTS_CHANNEL = 'movy_run_events';

/** `{runnerClass}` — a runner changed state: registered, draining, offline. */
export const RUNNERS_CHANNEL = 'movy_runners';

/** `{runnerClass}` — a probe was queued for that class. */
export const PROBES_CHANNEL = 'movy_probes';

/** `{id}` — a runner wrote that probe's result. */
export const PROBE_DONE_CHANNEL = 'movy_probe_done';

/** `{runnerClass}` — a run of that class was queued; an agent of the class claims it. */
export const RUNS_QUEUED_CHANNEL = 'movy_runs';

/**
 * `{runId}` — a run was settled. Sent by the `runs_settled_notify` trigger
 * (migration 0009) for EVERY settlement, never by application code: the ones
 * that matter emit no event — the sweeper's, a fenced or crashed runner's, a
 * spec that could not be read — and a watching client would otherwise show the
 * run running forever, because only events reach a live socket.
 */
export const RUN_SETTLED_CHANNEL = 'movy_run_settled';

/** `{runId}` — a user asked to cancel a running run; only the agent holding it acts. */
export const RUN_CANCEL_CHANNEL = 'movy_run_cancel';

/**
 * One string field of a pointer, or null. A payload is data from the database,
 * so it is checked rather than trusted, and an unreadable one is never thrown
 * out of a LISTEN handler: every receiver re-reads on its own anyway.
 */
export function parseStringField(payload: string, key: string): string | null {
  const parsed = parseObject(payload);
  const value = parsed?.[key];
  return typeof value === 'string' ? value : null;
}

/** `{runId, lastSeq}` from `RUN_EVENTS_CHANNEL`, or null; the next pointer catches up. */
export function parseEventPointer(payload: string): { runId: string; lastSeq: number } | null {
  const parsed = parseObject(payload);
  if (typeof parsed?.runId !== 'string' || typeof parsed.lastSeq !== 'number') return null;
  return { runId: parsed.runId, lastSeq: parsed.lastSeq };
}

function parseObject(payload: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
