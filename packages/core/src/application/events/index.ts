import { SequencedEventSink, MigrationEventSink } from '../../domain/ports/event-sink.port.js';
import { createSeqSink } from './seq-sink.js';
import { createThrottledSink } from './throttled-sink.js';
import { createSafeSink } from './safe-sink.js';

export { createSeqSink } from './seq-sink.js';
export { createThrottledSink } from './throttled-sink.js';
export { createSafeSink } from './safe-sink.js';

/**
 * The standard pipeline: safe( seq( throttled( target ) ) ).
 *
 * Throttling happens BEFORE sequencing so that coalesced events never consume
 * a seq number — otherwise a consumer would see gaps and think it had missed
 * something on reconnect.
 */
export function composeSink(
  runId: string,
  target: SequencedEventSink,
  options: { throttleMs?: number; onError?: (err: Error) => void } = {}
): MigrationEventSink & { flush: () => void } {
  const sequenced = createSeqSink(runId, target);
  const throttled = createThrottledSink(sequenced, options.throttleMs);
  const safe = createSafeSink(throttled, options.onError);
  const composed = ((event) => safe(event)) as MigrationEventSink & { flush: () => void };
  composed.flush = throttled.flush;
  return composed;
}
