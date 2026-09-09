import { SequencedEventSink, MigrationEventSink } from '../../domain/ports/event-sink.port.js';
import { createSeqSink } from './seq-sink.js';
import { createThrottledSink } from './throttled-sink.js';
import { createSafeSink } from './safe-sink.js';
import { createRedactingSink } from './redacting-sink.js';

export { createSeqSink } from './seq-sink.js';
export { createThrottledSink } from './throttled-sink.js';
export { createSafeSink } from './safe-sink.js';
export {
  createRedactingSink,
  redactValue,
  redactString,
  buildNeedles,
  REDACTED,
  MIN_REDACTABLE_SECRET_LENGTH,
} from './redacting-sink.js';

/**
 * The standard pipeline: safe( redact( throttled( seq( target ) ) ) ).
 *
 * Throttling happens BEFORE sequencing so that coalesced events never consume
 * a seq number — otherwise a consumer would see gaps and think it had missed
 * something on reconnect.
 *
 * Redaction sits outside the throttle so an event is scrubbed once on the way
 * in rather than once per surviving sample, and inside SafeSink so that a bug
 * in the scrubber cannot abort a migration either.
 */
export function composeSink(
  runId: string,
  target: SequencedEventSink,
  options: {
    throttleMs?: number;
    onError?: (err: Error) => void;
    /**
     * Values that must never reach the stream — in practice the source and
     * target passwords. Supplied by the caller because the sink is built before
     * the orchestrator and never sees a ConnectionConfig itself.
     */
    secrets?: readonly string[];
  } = {}
): MigrationEventSink & { flush: () => void } {
  const sequenced = createSeqSink(runId, target);
  const throttled = createThrottledSink(sequenced, options.throttleMs);
  const redacting = createRedactingSink(throttled, options.secrets);
  const safe = createSafeSink(redacting, options.onError);
  const composed = ((event) => safe(event)) as MigrationEventSink & { flush: () => void };
  composed.flush = throttled.flush;
  return composed;
}
