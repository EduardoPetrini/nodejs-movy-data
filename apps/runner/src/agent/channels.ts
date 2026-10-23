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
