import type { WireRunStatus } from '../../shared/run-wire';

/** What the hub must offer: who is watching, and a way to tell them. */
export interface SettledStatusHub {
  isWatching(runId: string): boolean;
  watchedRunIds(): string[];
  publishStatus(run: WireRunStatus): void;
}

export interface SettledStatusDeps {
  readonly hub: SettledStatusHub;
  /** The rows of these runs, scoped by id alone: the hub already holds a grant for each. */
  readonly loadStatuses: (runIds: readonly string[]) => Promise<WireRunStatus[]>;
  readonly onError?: (err: Error, runId?: string) => void;
}

const TERMINAL: ReadonlySet<string> = new Set(['succeeded', 'failed', 'cancelled']);

/**
 * Pushes the statuses no event carries.
 *
 * A run settled by its sweeper, by a fenced or crashed runner or by a spec that
 * could not be read emits nothing on its event stream; `movy_run_settled` is the
 * only way a watching browser learns of it. **NOTIFY has no replay**, so the
 * notification is not enough on its own: one sent while the LISTEN connection
 * was down is gone, and the browser's socket — still connected to this host —
 * would show the run running forever. `resync()` is the replay: on every
 * LISTEN reconnect it re-reads every watched run and pushes the settled ones.
 */
export class SettledStatusFeed {
  constructor(private readonly deps: SettledStatusDeps) {}

  /** One `movy_run_settled` notification. */
  async announce(runId: string): Promise<void> {
    if (!this.deps.hub.isWatching(runId)) return;
    await this.push([runId], false);
  }

  /** After a LISTEN reconnect: every settlement this host may have missed. */
  async resync(): Promise<void> {
    const watched = this.deps.hub.watchedRunIds();
    if (watched.length === 0) return;
    // Only settled ones: a still-running run's status reaches it by its events,
    // which the event feed's own resync re-reads.
    await this.push(watched, true);
  }

  private async push(runIds: readonly string[], settledOnly: boolean): Promise<void> {
    let rows: WireRunStatus[];
    try {
      rows = await this.deps.loadStatuses(runIds);
    } catch (err) {
      this.deps.onError?.(err instanceof Error ? err : new Error(String(err)), runIds.length === 1 ? runIds[0] : undefined);
      return;
    }
    for (const row of rows) {
      if (settledOnly && !TERMINAL.has(row.status)) continue;
      this.deps.hub.publishStatus(row);
    }
  }
}
