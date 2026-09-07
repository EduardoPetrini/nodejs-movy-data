import { MigrationEventInput } from '../../domain/types/events.types';
import { MigrationEventSink } from '../../domain/ports/event-sink.port';

/**
 * Swallows sink exceptions. A broken consumer (a closed IPC channel, a full
 * disk, a bug in a UI adapter) must never abort a migration that is mid-copy.
 */
export function createSafeSink(
  target: MigrationEventSink,
  onError?: (err: Error) => void
): MigrationEventSink {
  return (event: MigrationEventInput): void => {
    try {
      target(event);
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  };
}
