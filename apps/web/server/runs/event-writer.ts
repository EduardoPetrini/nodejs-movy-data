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
  /**
   * Called AFTER a batch is durably stored, never before.
   *
   * That ordering is what lets a client load a snapshot from the database and
   * then go live without a hole: by the time anyone is told an event exists,
   * it is already queryable. Broadcasting first would leave every event
   * between the snapshot read and the next flush invisible to a client that
   * joined in that window.
   */
  readonly onFlushed?: (runId: string, projection: Projection) => void;
  readonly setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout | number;
  readonly clearTimer?: (handle: NodeJS.Timeout | number) => void;
  /**
   * Ceiling on `log` events stored for one run. Structural events are never
   * capped — see `push`.
   */
  readonly maxLogEventsPerRun?: number;
  /** Called once per run, when the cap is first reached. */
  readonly onTruncated?: (runId: string, atSeq: number) => void;
}

/**
 * Log events past this are replaced by one notice and then dropped.
 *
 * `log` is the only unbounded event type. `table_progress` and
 * `overall_progress` are coalesced by `ThrottledSink` to four a second per key,
 * and the structural events are bounded by the plan — but `SinkLogger` puts
 * every `logger.*` call on the stream, and `MigrateDataUseCase` logs once per
 * progress callback, which is once per 500-row batch. A 50-million-row
 * migration therefore writes ~100k log rows into `run_events` for one run, and
 * nothing in the system stops it.
 *
 * 20k is chosen to be far above any run a person will read through and far
 * below a number that makes the table a problem.
 */
const DEFAULT_MAX_LOG_EVENTS_PER_RUN = 20_000;

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
  /** Per-run log-event tally, for the cap. Cleared when the run is forgotten. */
  private readonly logCounts = new Map<string, number>();
  private timer: NodeJS.Timeout | number | null = null;

  private readonly maxBatch: number;
  private readonly flushIntervalMs: number;
  private readonly onError: (err: Error, runId: string) => void;
  private readonly onFlushed: (runId: string, projection: Projection) => void;
  private readonly setTimer: NonNullable<EventWriterOptions['setTimer']>;
  private readonly clearTimer: NonNullable<EventWriterOptions['clearTimer']>;
  private readonly maxLogEventsPerRun: number;
  private readonly onTruncated: (runId: string, atSeq: number) => void;

  constructor(
    private readonly store: ProjectionStore,
    options: EventWriterOptions = {}
  ) {
    this.maxBatch = options.maxBatch ?? 200;
    this.flushIntervalMs = options.flushIntervalMs ?? 250;
    this.onError = options.onError ?? (() => {});
    this.onFlushed = options.onFlushed ?? (() => {});
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    this.maxLogEventsPerRun = options.maxLogEventsPerRun ?? DEFAULT_MAX_LOG_EVENTS_PER_RUN;
    this.onTruncated = options.onTruncated ?? (() => {});
  }

  /** Release a settled run's tally. Without this the map grows for the host's lifetime. */
  forget(runId: string): void {
    this.logCounts.delete(runId);
  }

  /**
   * Accepts one event, unless this run has already logged too much.
   *
   * Only `log` is capped. Dropping a `step_finished` or a `run_finished` would
   * leave a run permanently unsettled with a half-drawn timeline, which is a
   * far worse outcome than an unbounded table; dropping a progress sample would
   * freeze the bar. So the cap applies to the one type that is unbounded in the
   * size of the source database and useless in bulk.
   *
   * At the boundary the offending event is REPLACED by a notice carrying the
   * same `seq`, rather than skipped. The client de-dupes by seq and requires
   * only monotonicity, so a hole would be legal — but a log pane that simply
   * stops has no way to say why, and a person watching would read it as a hang.
   */
  push(runId: string, event: MigrationEvent): void {
    const stored = this.recordAndMaybeCap(runId, event);
    if (stored === null) return;
    event = stored;

    const buffer = this.buffers.get(runId);
    if (buffer) buffer.push(event);
    else this.buffers.set(runId, [event]);

    if ((this.buffers.get(runId)?.length ?? 0) >= this.maxBatch) {
      void this.flush(runId);
      return;
    }
    this.arm();
  }

  /**
   * Counts this run's log events and decides what, if anything, to store.
   *
   * Returns the event to store, a substituted truncation notice, or null to
   * drop it. The counter is per run and lives only as long as the process,
   * which is the right lifetime: after a restart the run is re-read from its
   * journal, and re-capping from zero writes at most one more notice — versus
   * a persisted counter that would need a column and a migration to save
   * duplicate rows that `ON CONFLICT DO NOTHING` already discards.
   */
  private recordAndMaybeCap(runId: string, event: MigrationEvent): MigrationEvent | null {
    if (event.type !== 'log') return event;

    const seen = (this.logCounts.get(runId) ?? 0) + 1;
    this.logCounts.set(runId, seen);

    if (seen < this.maxLogEventsPerRun) return event;

    if (seen === this.maxLogEventsPerRun) {
      this.onTruncated(runId, event.seq);
      return {
        ...event,
        level: 'warn',
        message:
          `Log output for this run passed ${this.maxLogEventsPerRun.toLocaleString()} lines and is no longer being ` +
          'recorded. The migration is unaffected and its progress and outcome are still tracked; ' +
          'the full log is in the run journal on the host.',
      };
    }
    return null;
  }

  /**
   * Drains everything held for one run, or for every run when given no id.
   *
   * Waits on IN-FLIGHT writes as well as buffered events. Callers use this to
   * mean "everything is durably stored now" — `RunManager` awaits it before
   * settling a run — and a version that only looked at the buffer returned
   * early whenever a write was already running, letting a run be settled
   * before its last events landed.
   */
  async flush(runId?: string): Promise<void> {
    const ids =
      runId === undefined
        ? new Set([...this.buffers.keys(), ...this.inFlight.keys()])
        : new Set([runId]);
    await Promise.all([...ids].map((id) => this.drain(id)));
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

    const projection = projectEvents(batch);
    const promise = this.store
      .apply(runId, projection)
      .then(() => {
        // Only on success. A batch that failed to store must not be announced
        // as live, or a reconnecting client would ask for events past a cursor
        // the database never advanced to.
        try {
          this.onFlushed(runId, projection);
        } catch (err) {
          this.onError(err instanceof Error ? err : new Error(String(err)), runId);
        }
      })
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
