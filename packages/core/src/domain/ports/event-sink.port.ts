import { MigrationEvent, MigrationEventInput } from '../types/events.types';

/**
 * Fire-and-forget event sink.
 *
 * MUST NOT throw and MUST NOT return a promise: telemetry is not allowed to
 * fail or slow down a migration. SafeSink enforces the first part for sinks
 * that cannot make the guarantee themselves.
 */
export type MigrationEventSink = (event: MigrationEventInput) => void;

/** A sink that has been through SeqSink and so carries full envelopes. */
export type SequencedEventSink = (event: MigrationEvent) => void;

/**
 * Per-run context threaded through the orchestrator and use cases as an
 * optional trailing parameter, so every existing call site and test mock keeps
 * compiling. Carries run identity, the event sink and the cancellation signal
 * together, so adding cancellation later does not churn the signatures again.
 */
export interface MigrationRunContext {
  readonly runId: string;
  readonly emit: MigrationEventSink;
  readonly signal?: AbortSignal;
}
