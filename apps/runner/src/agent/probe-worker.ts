import { claimProbe, completeProbe, type ClaimedProbe } from './probe-store';
import type { SqlClient } from './queue-store';
import {
  ProbeIncompatibleError, executeProbe, openProbe, type ProbeRequest, type ProbeResult,
} from '../probes/probe-wire';

/** The probe queue as one runner sees it: always this runner, always its class. */
export interface ProbeQueue {
  claim(): Promise<ClaimedProbe | null>;
  complete(probeId: string, result: ProbeResult): Promise<boolean>;
}

export interface ProbeWorkerOptions {
  readonly queue: ProbeQueue;
  /** Probes answered at once; separate from run slots. 0 answers none. */
  readonly slots: number;
  readonly open?: (orgId: string, probeId: string, ciphertext: Buffer) => ProbeRequest;
  readonly execute?: (request: ProbeRequest) => Promise<ProbeResult>;
  /** Fallback poll; `wake()` on NOTIFY is the fast path. 0 disables the timer. */
  readonly pollIntervalMs?: number;
  readonly onError?: (err: Error, probeId?: string) => void;
}

const DEFAULT_POLL_MS = 1_000;

/**
 * Answers Test and Preview for the runner's class: claims a probe, runs the
 * same executor the console runs in-request, writes the result.
 *
 * Its own slots, so a runner busy with a long migration still answers "can you
 * reach this database?" — the question that matters most when a run is failing.
 */
export class ProbeWorker {
  private readonly inFlight = new Set<Promise<void>>();
  private claiming: Promise<void> | null = null;
  private wakeAgain = false;
  private stopped = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly open: NonNullable<ProbeWorkerOptions['open']>;
  private readonly execute: NonNullable<ProbeWorkerOptions['execute']>;
  private readonly onError: NonNullable<ProbeWorkerOptions['onError']>;

  constructor(private readonly options: ProbeWorkerOptions) {
    this.open = options.open ?? openProbe;
    this.execute = options.execute ?? executeProbe;
    this.onError = options.onError ?? (() => {});
  }

  start(): void {
    if (this.options.slots <= 0) return;
    this.stopped = false;
    const pollMs = this.options.pollIntervalMs ?? DEFAULT_POLL_MS;
    if (pollMs > 0) {
      this.pollTimer = setInterval(() => void this.wake(), pollMs);
      this.pollTimer.unref?.();
    }
    void this.wake();
  }

  /** Claims probes until its slots are full or none is queued. */
  wake(): Promise<void> {
    if (this.stopped || this.options.slots <= 0) return Promise.resolve();
    if (this.claiming) {
      this.wakeAgain = true;
      return this.claiming;
    }
    this.claiming = this.claimLoop().finally(() => {
      this.claiming = null;
      if (this.wakeAgain) {
        this.wakeAgain = false;
        void this.wake();
      }
    });
    return this.claiming;
  }

  /** Claims nothing more and waits for the probes in flight. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    await this.claiming;
    await Promise.all(this.inFlight);
  }

  /** Probes running now, for tests and for the drain. */
  get busy(): number {
    return this.inFlight.size;
  }

  private async claimLoop(): Promise<void> {
    while (!this.stopped && this.inFlight.size < this.options.slots) {
      let claimed: ClaimedProbe | null;
      try {
        claimed = await this.options.queue.claim();
      } catch (err) {
        this.onError(toError(err));
        return;
      }
      if (!claimed) return;
      const job: Promise<void> = this.answer(claimed).finally(() => {
        this.inFlight.delete(job);
        // A slot came free: there may be another one waiting.
        void this.wake();
      });
      this.inFlight.add(job);
    }
  }

  private async answer(claimed: ClaimedProbe): Promise<void> {
    let result: ProbeResult;
    try {
      const request = this.open(claimed.orgId, claimed.id, claimed.ciphertext);
      result = await this.execute(request);
    } catch (err) {
      // Only `open` can get here — `executeProbe` turns every failure into a
      // result. Its message is ours, never the request's.
      const message =
        err instanceof ProbeIncompatibleError
          ? err.message
          : "This runner could not decrypt the request. It must share the console's encryption key.";
      result =
        claimed.kind === 'test'
          ? { ok: false, latencyMs: 0, error: message, errorKind: 'unknown' }
          : { ok: false, side: null, errorKind: 'unknown', message };
    }
    try {
      await this.options.queue.complete(claimed.id, result);
    } catch (err) {
      this.onError(toError(err), claimed.id);
    }
  }
}

/** The SQL probe queue bound to one runner and its class. */
export function sqlProbeQueue(sql: SqlClient, runnerId: string, runnerClass: string): ProbeQueue {
  return {
    claim: () => claimProbe(sql, runnerId, runnerClass),
    complete: (probeId, result) => completeProbe(sql, probeId, result),
  };
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
