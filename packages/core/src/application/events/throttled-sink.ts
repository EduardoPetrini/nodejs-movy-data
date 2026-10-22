import { MigrationEventInput } from '../../domain/types/events.types.js';
import { MigrationEventSink } from '../../domain/ports/event-sink.port.js';

const DEFAULT_INTERVAL_MS = 250;

/**
 * Coalesces high-frequency progress events, passing everything else straight
 * through.
 *
 * Necessary because CrossDbDataMigrator invokes its progress callback once per
 * 500-row batch: a 5M-row table produces 10,000 events. (The PG->PG worker
 * already self-throttles to 10% granularity via lastReportedPct; the cross-db
 * path does not.)
 *
 * A table's pending sample is flushed when that table finishes, so the last
 * number a viewer sees is always the real one. Call flush() before shutdown.
 */
export function createThrottledSink(
  target: MigrationEventSink,
  intervalMs: number = DEFAULT_INTERVAL_MS,
  now: () => number = () => Date.now()
): MigrationEventSink & { flush: () => void } {
  const lastSentAt = new Map<string, number>();
  const pending = new Map<string, MigrationEventInput>();

  const keyOf = (event: MigrationEventInput): string | null => {
    if (event.type === 'table_progress') return `table:${event.tableName}`;
    if (event.type === 'overall_progress') return 'overall';
    return null;
  };

  const flushKey = (key: string): void => {
    const held = pending.get(key);
    if (!held) return;
    pending.delete(key);
    lastSentAt.set(key, now());
    target(held);
  };

  const sink = (event: MigrationEventInput): void => {
    const key = keyOf(event);

    if (key === null) {
      // A finished table's held sample must land before its terminal event,
      // otherwise the UI shows a stale count next to "done".
      if (event.type === 'table_finished') {
        flushKey(`table:${event.tableName}`);
        flushKey('overall');
      }
      target(event);
      return;
    }

    const elapsed = now() - (lastSentAt.get(key) ?? -Infinity);
    if (elapsed >= intervalMs) {
      pending.delete(key);
      lastSentAt.set(key, now());
      target(event);
      return;
    }
    pending.set(key, event);
  };

  sink.flush = (): void => {
    for (const key of [...pending.keys()]) flushKey(key);
  };

  return sink;
}
