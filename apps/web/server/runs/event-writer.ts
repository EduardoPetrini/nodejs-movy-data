import type { MigrationEvent } from '@movy/core';
import { projectEvents } from './run-projection';
import type { Projection } from './run-projection';

/**
 * Where a folded batch goes. An interface rather than the Drizzle call directly,
 * so the batching rules below are testable without a database — and so the
 * journal tailer can reuse the writer unchanged.
 */
export interface ProjectionStore {
  apply(runId: string, projection: Projection): Promise<void>;
}

export interface EventWriterOptions {
  /** Flush once this many events are held, whatever the clock says. */
  readonly maxBatch?: number;
  /** …and at least this often, so a quiet run still lands its last event. */
  readonly flushIntervalMs?: number;
  readonly onError?: (err: Error, runId: string) => void;
  readonly setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout | number;
  readonly clearTimer?: (handle: NodeJS.Timeout | number) => void;
}

/**
 * Batches run events into the metadata database.
 *
 * A 315k-row PG→PG run emits thousands of events even after `ThrottledSink`
 * coalesces progress, and one INSERT each would make Movy's own database the
 * bottleneck in watching a migration. Batching is safe here precisely because
 * the journal — not this table — is the system of record: anything lost in a
 * crash between flushes is re-read from the file on the next boot.
 *
 * Per-run buffers, one in-flight flush per run. Ordering within a run is
 * preserved; ordering across runs is irrelevant.
 */
export class EventWriter {
  private readonly buffers = new Map<string, MigrationEvent[]>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | number | null = null;

  private readonly maxBatch: number;
  private readonly flushIntervalMs: number;
  private readonly onError: (err: Error, runId: string) => void;
  private readonly setTimer: NonNullable<EventWriterOptions['setTimer']>;
  private readonly clearTimer: NonNullable<EventWriterOptions['clearTimer']>;

  constructor(
    private readonly store: ProjectionStore,
    options: EventWriterOptions = {}
  ) {
    this.maxBatch = options.maxBatch ?? 200;
    this.flushIntervalMs = options.flushIntervalMs ?? 250;
    this.onError = options.onError ?? (() => {});
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  push(runId: string, event: MigrationEvent): void {
    const buffer = this.buffers.get(runId);
    if (buffer) buffer.push(event);
    else this.buffers.set(runId, [event]);

    if ((this.buffers.get(runId)?.length ?? 0) >= this.maxBatch) {
      void this.flush(runId);
      return;
    }
    this.arm();
  }

  /** Drains everything held for one run, or for every run when given no id. */
  async flush(runId?: string): Promise<void> {
    const ids = runId === undefined ? [...this.buffers.keys()] : [runId];
    await Promise.all(ids.map((id) => this.drain(id)));
  }

  /** Flush and stop the timer. A writer that keeps a timer alive keeps Nitro alive. */
  async close(): Promise<void> {
    this.disarm();
    await this.flush();
  }

  private arm(): void {
    if (this.timer !== null) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.flush().catch(() => {});
    }, this.flushIntervalMs);
    // A pending flush must not be what holds the process open at shutdown.
    (this.timer as NodeJS.Timeout).unref?.();
  }

  private disarm(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  private drain(runId: string): Promise<void> {
    // One flush per run at a time. Two concurrent transactions writing the same
    // `runs` row would deadlock as readily as they would interleave, and the
    // projection's "later wins" rule assumes batches land in order.
    const pending = this.inFlight.get(runId);
    if (pending) return pending.then(() => this.drain(runId));

    const batch = this.buffers.get(runId);
    if (!batch || batch.length === 0) return Promise.resolve();
    this.buffers.delete(runId);

    const promise = this.store
      .apply(runId, projectEvents(batch))
      .catch((err: unknown) => {
        // Never rethrown into the IPC handler: a failed metadata write must
        // not take down the process supervising a live migration. The journal
        // still holds every event, and the tailer replays them on next boot.
        this.onError(err instanceof Error ? err : new Error(String(err)), runId);
      })
      .finally(() => {
        this.inFlight.delete(runId);
      });

    this.inFlight.set(runId, promise);
    return promise;
  }
}
