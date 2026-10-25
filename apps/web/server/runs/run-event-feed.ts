import type { WireEvent } from '../../shared/run-wire';

/** What the feed needs. Narrow, so every ordering rule is testable without a database. */
export interface RunEventFeedDeps {
  /** `runs.last_seq`: the highest seq durably stored. */
  currentSeq(runId: string): Promise<number>;
  /** Stored events with seq > afterSeq, ascending, at most `limit`. Every cohort's. */
  readAfter(runId: string, afterSeq: number, limit: number): Promise<WireEvent[]>;
  /** The hub's fan-out, which splits the cohorts. */
  publish(runId: string, events: readonly WireEvent[]): void;
  /** Whether any socket on this host watches the run. */
  isWatched(runId: string): boolean;
}

export interface RunEventFeedOptions {
  readonly pageSize?: number;
  /** Wait before re-reading after a failed read or fan-out. */
  readonly retryMs?: number;
  readonly onError?: (err: Error, runId: string) => void;
}

interface Cursor {
  seq: number;
  /** The read in flight, if any. Reads for one run never overlap. */
  reading: Promise<void> | null;
  /** A notification arrived during the read: read once more when it ends. */
  again: boolean;
  /** A re-read scheduled after a failure. At most one per run. */
  retry: NodeJS.Timeout | null;
}

/**
 * Turns `NOTIFY movy_run_events` into frames for the hub.
 *
 * A notification is a POINTER — `{runId, lastSeq}` — never the events: NOTIFY
 * payloads are capped at 8 KB, and the events are in `run_events` already. So
 * the feed keeps a cursor per watched run and reads past it.
 *
 * The ordering rules this replaces were properties of `EventWriter.onFlushed`
 * in one process. They are properties of the database now, so they hold for an
 * agent in any process:
 * - **after the durable write**: NOTIFY is delivered only on commit, and the
 *   feed reads committed rows;
 * - **join before snapshot**: `track()` fixes the cursor before the snapshot is
 *   read, so anything stored after it arrives live — an overlap the client
 *   drops by seq, never a gap;
 * - **no gap across a lost listener**: `resync()` reads past every cursor.
 */
export class RunEventFeed {
  private readonly cursors = new Map<string, Cursor>();
  private readonly pageSize: number;
  private readonly retryMs: number;
  private readonly onError: NonNullable<RunEventFeedOptions['onError']>;

  constructor(private readonly deps: RunEventFeedDeps, options: RunEventFeedOptions = {}) {
    this.pageSize = options.pageSize ?? 500;
    this.retryMs = options.retryMs ?? 2_000;
    this.onError = options.onError ?? (() => {});
  }

  /**
   * Starts following a run, from what is stored now. Await it BEFORE reading a
   * subscriber's snapshot. A run already followed keeps its cursor: moving it
   * forward would skip events for the peers already watching.
   */
  async track(runId: string): Promise<void> {
    if (this.cursors.has(runId)) return;
    const seq = await this.deps.currentSeq(runId);
    if (!this.cursors.has(runId)) this.cursors.set(runId, { seq, reading: null, again: false, retry: null });
  }

  /** A notification arrived. Cheap and synchronous: the read is scheduled, not awaited. */
  notify(runId: string, lastSeq: number): void {
    const cursor = this.cursors.get(runId);
    if (!cursor) return;
    if (!this.deps.isWatched(runId)) {
      this.cursors.delete(runId);
      return;
    }
    if (lastSeq <= cursor.seq && !cursor.reading) return;
    this.pull(runId, cursor);
  }

  /** The listener reconnected: whatever was sent meanwhile is lost, so read past every cursor. */
  resync(): void {
    for (const [runId, cursor] of this.cursors) {
      if (!this.deps.isWatched(runId)) this.cursors.delete(runId);
      else this.pull(runId, cursor);
    }
  }

  tracked(): string[] {
    return [...this.cursors.keys()];
  }

  /** Resolves when no read is in flight. For tests and shutdown. */
  async idle(): Promise<void> {
    for (;;) {
      const pending = [...this.cursors.values()].map((c) => c.reading).filter((p): p is Promise<void> => p !== null);
      if (pending.length === 0) return;
      await Promise.all(pending);
    }
  }

  private pull(runId: string, cursor: Cursor): void {
    if (cursor.reading) {
      cursor.again = true;
      return;
    }
    cursor.reading = this.drain(runId, cursor).finally(() => {
      cursor.reading = null;
      if (cursor.again) {
        cursor.again = false;
        this.pull(runId, cursor);
      }
    });
  }

  private async drain(runId: string, cursor: Cursor): Promise<void> {
    try {
      for (;;) {
        const events = await this.deps.readAfter(runId, cursor.seq, this.pageSize);
        if (events.length === 0) return;
        this.deps.publish(runId, events);
        // Moved only once the fan-out returned: a throw re-reads the range, and
        // an overlap is a duplicate the client drops by seq, which a gap is not.
        cursor.seq = events[events.length - 1]!.seq;
        if (events.length < this.pageSize) return;
      }
    } catch (err) {
      this.onError(err instanceof Error ? err : new Error(String(err)), runId);
      this.scheduleRetry(runId, cursor);
    }
  }

  /**
   * The cursor did not move, but waiting for the next notification is not
   * enough: the read that failed may have held `run_finished`, after which no
   * notification for this run ever comes. Stops once nobody here watches it.
   */
  private scheduleRetry(runId: string, cursor: Cursor): void {
    if (cursor.retry) return;
    cursor.retry = setTimeout(() => {
      cursor.retry = null;
      if (this.cursors.get(runId) !== cursor) return;
      if (!this.deps.isWatched(runId)) {
        this.cursors.delete(runId);
        return;
      }
      this.pull(runId, cursor);
    }, this.retryMs);
    cursor.retry.unref?.();
  }
}
