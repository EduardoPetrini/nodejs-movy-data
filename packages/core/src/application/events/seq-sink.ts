import { MigrationEvent, MigrationEventInput } from '../../domain/types/events.types.js';
import { MigrationEventSink, SequencedEventSink } from '../../domain/ports/event-sink.port.js';

/**
 * Stamps runId, a monotonic seq and a timestamp onto every event, then
 * delegates. The only place seq is assigned, which is what lets a consumer use
 * it as a replay cursor and drop duplicates.
 *
 * Runs in the child process, not in the web server: a parent-owned counter
 * would restart at 0 on a server restart and destroy the cursor.
 */
export function createSeqSink(
  runId: string,
  target: SequencedEventSink,
  now: () => Date = () => new Date()
): MigrationEventSink {
  let seq = 0;
  return (event: MigrationEventInput): void => {
    seq += 1;
    target({ ...event, runId, seq, at: now().toISOString() } as MigrationEvent);
  };
}
