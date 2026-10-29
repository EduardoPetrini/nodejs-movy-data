import type { LaunchRequest, ReattachResult } from './run-manager';
import {
  DEFAULT_LEASE_MS,
  claimNextRun,
  heartbeat,
  registerRunner,
  setRunnerState,
  settleClaimedRun,
  takeRunSpec,
  type ClaimedRun,
  type HeartbeatResult,
  type RunnerRegistration,
  type SealedSpec,
  type Settlement,
  type SqlClient,
} from './queue-store';
import { RunSpecIncompatibleError, openRunSpec, type RunSpecEnvelope } from './run-spec-envelope';

/** The queue as the agent sees it: always this runner, always its class. */
export interface AgentQueue {
  register(): Promise<void>;
  setState(state: 'online' | 'draining' | 'offline'): Promise<void>;
  claimNext(): Promise<ClaimedRun | null>;
  takeSpec(runId: string): Promise<SealedSpec | null>;
  heartbeat(busy: number): Promise<HeartbeatResult>;
  settle(runId: string, outcome: Settlement): Promise<boolean>;
}

/** What the agent needs of `RunManager`. */
export interface AgentRunControl {
  launch(request: LaunchRequest): void;
  cancel(runId: string, pid: number | null): Promise<boolean>;
  terminate(runId: string): boolean;
  liveRunIds(): string[];
  reattach(): Promise<Pick<ReattachResult, 'recovered' | 'settled' | 'following'> & { leased?: readonly string[] }>;
  shutdown(): void;
}

export interface RunnerAgentOptions {
  readonly queue: AgentQueue;
  readonly control: AgentRunControl;
  /** Runs this agent executes at once. */
  readonly slots: number;
  /**
   * Claims before it stops claiming for good; undefined is unlimited. With 1,
   * one Kubernetes Job is one run: the Job's pod exits once `exhausted`.
   */
  readonly maxRuns?: number;
  readonly journalPathFor: (runId: string) => string;
  /** The recording a simulated run replays, on THIS host; undefined when there is none. */
  readonly simulationFixture: () => string | undefined;
  readonly openSpec?: (orgId: string, runId: string, sealed: SealedSpec) => RunSpecEnvelope;
  /** Fallback poll for queued work; `wake()` is the fast path. 0 disables the timer. */
  readonly pollIntervalMs?: number;
  /** 0 disables the timer, for tests that drive `beat()` themselves. */
  readonly heartbeatIntervalMs?: number;
  /**
   * The lease the queue grants. A run whose lease was last renewed this long
   * ago (less `fenceMarginMs`) may already be settled by the sweeper, so the
   * agent stops it itself rather than wait to hear so from a database it
   * cannot reach.
   */
  readonly leaseMs?: number;
  /** How long BEFORE its lease can expire a run is stopped. */
  readonly fenceMarginMs?: number;
  /** How often the lease deadlines are checked, apart from any heartbeat. 0 disables the timer. */
  readonly leaseCheckIntervalMs?: number;
  /** Injectable for tests. */
  readonly now?: () => number;
  readonly onError?: (err: Error, runId?: string) => void;
  /** A run lost its lease and was stopped here. */
  readonly onFenced?: (runId: string) => void;
}

const DEFAULT_POLL_MS = 5_000;
const DEFAULT_HEARTBEAT_MS = 5_000;
const DRAIN_CHECK_MS = 250;
/** One heartbeat interval: the lease is gone by the time a later beat could say so. */
const DEFAULT_FENCE_MARGIN_MS = 5_000;
const DEFAULT_LEASE_CHECK_MS = 1_000;

/**
 * One runner agent: claims queued runs of its class, forks the runner for each,
 * keeps their leases alive, and stops any run whose lease it has lost.
 *
 * Embedded in the web console by default (`MOVY_EMBEDDED_RUNNER`), or its own
 * process from phase 6 of docs/runner-service-plan.md. The same class either way.
 */
export class RunnerAgent {
  /**
   * Runs this agent holds a lease on — claimed here, or recovered after a
   * restart — and when the request that last renewed each lease was SENT.
   * The database stamped the lease no earlier than that, so a deadline
   * measured from it can only be early, never late.
   */
  private readonly owned = new Map<string, number>();
  /** Claimed, not launched yet: absent from `liveRunIds()` without having finished. */
  private readonly launching = new Set<string>();
  /** Cancels already forwarded, so a heartbeat does not re-send one every beat. */
  private readonly cancelSent = new Set<string>();
  private claiming: Promise<void> | null = null;
  /** Every claim, whether or not its run started: a spent claim is spent. */
  private claims = 0;
  private wakeAgain = false;
  private draining = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private beatTimer: NodeJS.Timeout | null = null;
  private leaseTimer: NodeJS.Timeout | null = null;
  private readonly openSpec: NonNullable<RunnerAgentOptions['openSpec']>;
  private readonly onError: NonNullable<RunnerAgentOptions['onError']>;
  private readonly now: () => number;

  constructor(private readonly options: RunnerAgentOptions) {
    this.openSpec = options.openSpec ?? openRunSpec;
    this.onError = options.onError ?? (() => {});
    this.now = options.now ?? Date.now;
  }

  /**
   * Registers, re-attaches to the runs it owned before a restart, takes its
   * first heartbeat — extending those runs' leases before any sweeper looks at
   * them — and only then starts claiming.
   *
   * A recovered run with a lease is owned like a claimed one, so losing its
   * lease stops it. Its renewal time is unknown — the last beat was the old
   * process's — so until a beat here confirms it, it counts as already due:
   * the first beat answers for it, and if that beat fails it is stopped.
   *
   * The lease watchdog is armed BEFORE that beat. The beat awaits a heartbeat
   * and then the whole claim loop; a heartbeat that hangs — the embedded pool
   * has no query timeout — would otherwise leave the recovered runs writing
   * with nothing to stop them. A first beat slower than one check interval
   * therefore stops them: the remaining lease is unknown, and guessing it is
   * long is the guess that lets two writers share a destination.
   */
  async start(): Promise<void> {
    const { queue, control } = this.options;
    await queue.register();
    const recovered = await control.reattach();
    for (const runId of recovered.leased ?? []) this.owned.set(runId, Number.NEGATIVE_INFINITY);

    const leaseCheckMs = this.options.leaseCheckIntervalMs ?? DEFAULT_LEASE_CHECK_MS;
    if (leaseCheckMs > 0 && !this.leaseTimer) {
      this.leaseTimer = unref(setInterval(() => this.checkLeases(), leaseCheckMs));
    }
    await this.beat();

    const pollMs = this.options.pollIntervalMs ?? DEFAULT_POLL_MS;
    const beatMs = this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
    if (pollMs > 0) this.pollTimer = unref(setInterval(() => void this.wake(), pollMs));
    if (beatMs > 0) this.beatTimer = unref(setInterval(() => void this.beat(), beatMs));
  }

  /**
   * Reached its run limit and every run it claimed has finished here: an agent
   * with nothing left to do and nothing it may take on. Never true without
   * `maxRuns`, nor before the first claim, so an idle Job leaves by its idle
   * exit rather than this.
   */
  get exhausted(): boolean {
    return this.limitReached() && this.launching.size === 0 && this.options.control.liveRunIds().length === 0;
  }

  /** Claims queued runs until its slots are full or the queue is empty. */
  wake(): Promise<void> {
    if (this.draining) return Promise.resolve();
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

  /**
   * Forwards a cancel to a run live on THIS host; false for any other, which
   * its own runner picks up from the `cancelling` row on its next heartbeat.
   * Asking RunManager about a run it does not hold would settle it as gone.
   */
  async cancel(runId: string, pid: number | null = null): Promise<boolean> {
    if (!this.options.control.liveRunIds().includes(runId)) return false;
    // A NOTIFY and the console's own fast path can both arrive; forward once.
    if (this.cancelSent.has(runId)) return true;
    this.cancelSent.add(runId);
    try {
      return await this.options.control.cancel(runId, pid);
    } catch (err) {
      // Heartbeats call this without awaiting it, so a rejection here would be
      // an unhandled one. Unmarked, the next beat that sees `cancelling` retries.
      this.cancelSent.delete(runId);
      this.onError(toError(err), runId);
      return false;
    }
  }

  /** One heartbeat: extend leases, fence what was lost, forward cancels, then claim. */
  async beat(): Promise<void> {
    const { queue, control } = this.options;
    // Judged against the runs live BEFORE the query: `wake()` may claim and
    // launch while it is in flight, and the statement's snapshot cannot see a
    // claim committed after it began — that run is missing from `held` without
    // having been swept. It, and one still between claim and launch, waits for
    // the next beat.
    const liveBefore = new Set(control.liveRunIds());
    const sentAt = this.now();
    let result: HeartbeatResult;
    try {
      result = await queue.heartbeat(liveBefore.size);
    } catch (err) {
      // A missed beat is not fatal: the lease has five more before it expires.
      this.onError(toError(err));
      this.checkLeases();
      return;
    }

    const live = new Set(control.liveRunIds());
    const held = new Set(result.held);
    for (const runId of [...this.owned.keys()]) {
      if (!liveBefore.has(runId)) {
        // Launching, or launched while the beat was in flight: the next beat
        // judges it. Anything else was here once and has finished.
        if (!this.launching.has(runId) && !live.has(runId)) this.release(runId);
        continue;
      }
      if (!live.has(runId)) {
        this.release(runId);
      } else if (!held.has(runId)) {
        // The sweeper settled it: as far as the ledger is concerned this run is
        // over and its destination is free. Writing on would be the harm.
        this.fence(runId);
      } else {
        this.owned.set(runId, sentAt);
      }
    }
    for (const runId of result.cancelling) {
      if (live.has(runId) && !this.cancelSent.has(runId)) void this.cancel(runId);
    }

    if (!this.draining) await this.wake();
  }

  /**
   * Stops every run whose lease may expire before anything here could renew
   * it: as far as the ledger may soon say, it is over and its destination
   * free. Stopping it is the only safe guess — a partially applied run is
   * reported either way, but two writers into one destination is the harm the
   * lease exists to prevent.
   *
   * On its own timer, never only after a heartbeat fails: a query into a dead
   * connection can take longer than the lease to fail, and the embedded pool
   * has no query timeout at all.
   */
  checkLeases(): void {
    const deadline = (this.options.leaseMs ?? DEFAULT_LEASE_MS) - (this.options.fenceMarginMs ?? DEFAULT_FENCE_MARGIN_MS);
    const now = this.now();
    for (const [runId, renewedAt] of [...this.owned]) {
      if (now - renewedAt >= deadline) this.fence(runId);
    }
  }

  private fence(runId: string): void {
    this.options.control.terminate(runId);
    this.release(runId);
    this.options.onFenced?.(runId);
  }

  private release(runId: string): void {
    this.owned.delete(runId);
    this.cancelSent.delete(runId);
  }

  /**
   * Graceful stop: claim nothing more, let what is running finish for up to
   * `timeoutMs`, then go offline. It never cancels a run on the user's behalf;
   * whatever outlives the grace period is settled by the sweeper.
   */
  async drain(timeoutMs: number): Promise<void> {
    await this.stopClaiming();

    const deadline = Date.now() + timeoutMs;
    while (this.options.control.liveRunIds().length > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, DRAIN_CHECK_MS));
    }
    await this.stop();
  }

  /**
   * The first half of a drain: claim nothing more and say so, without waiting
   * for anything. A shutdown calls it before waiting on its probes, which can
   * take a minute — a run claimed in that minute would be left behind by a
   * drain that had already begun. Calling it again is a no-op.
   */
  async stopClaiming(): Promise<void> {
    if (this.draining) return;
    await this.beginDrain();
    await this.claiming;
  }

  /**
   * Claims nothing more and says so. Never awaits the claim loop, so the loop
   * itself can call it on reaching its limit without waiting on itself.
   */
  private async beginDrain(): Promise<void> {
    this.draining = true;
    this.clearPoll();
    await this.safely(() => this.options.queue.setState('draining'));
  }

  private limitReached(): boolean {
    return this.options.maxRuns !== undefined && this.claims >= this.options.maxRuns;
  }

  /**
   * Immediate stop, for an embedded agent whose host is shutting down. The
   * children are detached and keep running; the restarted host re-attaches.
   */
  async stop(): Promise<void> {
    this.draining = true;
    this.clearPoll();
    if (this.beatTimer) clearInterval(this.beatTimer);
    this.beatTimer = null;
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = null;
    await this.claiming;
    await this.safely(() => this.options.queue.setState('offline'));
    this.options.control.shutdown();
  }

  private async claimLoop(): Promise<void> {
    const { queue, control, slots } = this.options;
    while (!this.draining && control.liveRunIds().length < slots) {
      let claimed: ClaimedRun | null;
      const sentAt = this.now();
      try {
        claimed = await queue.claimNext();
      } catch (err) {
        this.onError(toError(err));
        return;
      }
      if (!claimed) return;
      this.claims += 1;
      // The claim grants the lease, so its deadline runs from the claim.
      this.owned.set(claimed.id, sentAt);
      this.launching.add(claimed.id);
      try {
        await this.startRun(claimed);
      } finally {
        this.launching.delete(claimed.id);
      }
      // Draining stops claiming only: the beat keeps renewing this run's lease.
      if (this.limitReached()) return this.beginDrain();
    }
  }

  private async startRun(claimed: ClaimedRun): Promise<void> {
    const { queue, control } = this.options;

    let sealed: SealedSpec | null;
    try {
      sealed = await queue.takeSpec(claimed.id);
    } catch (err) {
      // Not "gone": the database did not answer, and saying otherwise sends
      // someone looking for a deleted spec that was never touched.
      this.onError(toError(err), claimed.id);
      return this.fail(
        claimed.id,
        'RunSpecUnavailable',
        "The runner could not read this run's specification from the metadata database. Launch it again."
      );
    }
    if (!sealed) {
      return this.fail(claimed.id, 'RunSpecMissing', 'The run was claimed but its specification was gone.');
    }

    let envelope: RunSpecEnvelope;
    try {
      envelope = this.openSpec(claimed.orgId, claimed.id, sealed);
    } catch (err) {
      if (err instanceof RunSpecIncompatibleError) return this.fail(claimed.id, err.name, err.message);
      return this.fail(
        claimed.id,
        'RunSpecUnreadable',
        "This runner could not decrypt the run's specification. It must share the console's encryption key."
      );
    }

    // Judged here, synchronously before the launch, not only by the timer: a
    // claim whose answer arrived past its deadline was never visible to the
    // watchdog, and launched now it would write until the next tick — into a
    // destination the sweeper may already have handed to someone else.
    this.checkLeases();
    // Fenced while its spec was being read, or just now: the lease is gone, so is the run.
    if (!this.owned.has(claimed.id)) return;

    try {
      const journalPath = this.options.journalPathFor(claimed.id);
      if (envelope.simulate) {
        const fixture = this.options.simulationFixture();
        if (!fixture) {
          return this.fail(claimed.id, 'NoSimulationFixture', 'No simulation recording is available on this runner.');
        }
        control.launch({ runId: claimed.id, journalPath, spec: undefined, simulateFixture: fixture, speed: envelope.speed });
      } else {
        control.launch({ runId: claimed.id, journalPath, spec: envelope.spec });
      }
    } catch (err) {
      this.onError(toError(err), claimed.id);
      return this.fail(claimed.id, 'RunnerFatal', 'The runner process could not be started.');
    }
  }

  private async fail(runId: string, errorName: string, errorMessage: string): Promise<void> {
    this.release(runId);
    await this.safely(() => this.options.queue.settle(runId, { status: 'failed', errorName, errorMessage }));
  }

  private async safely<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      this.onError(toError(err));
      return undefined;
    }
  }

  private clearPoll(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }
}

/** The SQL queue bound to one runner and its class. */
export function sqlAgentQueue(sql: SqlClient, registration: RunnerRegistration, leaseMs = DEFAULT_LEASE_MS): AgentQueue {
  return {
    register: () => registerRunner(sql, registration),
    setState: (state) => setRunnerState(sql, registration.id, state),
    claimNext: () => claimNextRun(sql, registration.id, registration.runnerClass, leaseMs),
    takeSpec: (runId) => takeRunSpec(sql, runId),
    heartbeat: (busy) => heartbeat(sql, registration.id, busy, leaseMs),
    settle: (runId, outcome) => settleClaimedRun(sql, runId, outcome),
  };
}

function unref(timer: NodeJS.Timeout): NodeJS.Timeout {
  timer.unref?.();
  return timer;
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
