import type { LaunchRequest } from './run-manager';
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
  reattach(): Promise<{ recovered: number; settled: number; following: number }>;
  shutdown(): void;
}

export interface RunnerAgentOptions {
  readonly queue: AgentQueue;
  readonly control: AgentRunControl;
  /** Runs this agent executes at once. */
  readonly slots: number;
  readonly journalPathFor: (runId: string) => string;
  /** The recording a simulated run replays, on THIS host; undefined when there is none. */
  readonly simulationFixture: () => string | undefined;
  readonly openSpec?: (orgId: string, runId: string, sealed: SealedSpec) => RunSpecEnvelope;
  /** Fallback poll for queued work; `wake()` is the fast path. 0 disables the timer. */
  readonly pollIntervalMs?: number;
  /** 0 disables the timer, for tests that drive `beat()` themselves. */
  readonly heartbeatIntervalMs?: number;
  /**
   * The lease the queue grants. When no heartbeat has succeeded for this long,
   * the sweeper may already have settled this agent's runs, so it stops them
   * itself rather than wait to hear so from a database it cannot reach.
   */
  readonly leaseMs?: number;
  /** Injectable for tests. */
  readonly now?: () => number;
  readonly onError?: (err: Error, runId?: string) => void;
  /** A run lost its lease and was stopped here. */
  readonly onFenced?: (runId: string) => void;
}

const DEFAULT_POLL_MS = 5_000;
const DEFAULT_HEARTBEAT_MS = 5_000;
const DRAIN_CHECK_MS = 250;

/**
 * One runner agent: claims queued runs of its class, forks the runner for each,
 * keeps their leases alive, and stops any run whose lease it has lost.
 *
 * Embedded in the web console by default (`MOVY_EMBEDDED_RUNNER`), or its own
 * process from phase 6 of docs/runner-service-plan.md. The same class either way.
 */
export class RunnerAgent {
  /** Runs claimed by this process — the ones it must fence if their lease goes. */
  private readonly owned = new Set<string>();
  /** Cancels already forwarded, so a heartbeat does not re-send one every beat. */
  private readonly cancelSent = new Set<string>();
  private claiming: Promise<void> | null = null;
  private wakeAgain = false;
  private draining = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private beatTimer: NodeJS.Timeout | null = null;
  private readonly openSpec: NonNullable<RunnerAgentOptions['openSpec']>;
  private readonly onError: NonNullable<RunnerAgentOptions['onError']>;
  private readonly now: () => number;
  private lastBeatOkAt: number;

  constructor(private readonly options: RunnerAgentOptions) {
    this.openSpec = options.openSpec ?? openRunSpec;
    this.onError = options.onError ?? (() => {});
    this.now = options.now ?? Date.now;
    this.lastBeatOkAt = this.now();
  }

  /**
   * Registers, re-attaches to the runs it owned before a restart, takes its
   * first heartbeat — extending those runs' leases before any sweeper looks at
   * them — and only then starts claiming.
   */
  async start(): Promise<void> {
    const { queue, control } = this.options;
    await queue.register();
    await control.reattach();
    await this.beat();

    const pollMs = this.options.pollIntervalMs ?? DEFAULT_POLL_MS;
    const beatMs = this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
    if (pollMs > 0) this.pollTimer = unref(setInterval(() => void this.wake(), pollMs));
    if (beatMs > 0) this.beatTimer = unref(setInterval(() => void this.beat(), beatMs));
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
    let result: HeartbeatResult;
    try {
      result = await queue.heartbeat(liveBefore.size);
    } catch (err) {
      // A missed beat is not fatal: the lease has five more before it expires.
      this.onError(toError(err));
      this.selfFenceIfLeaseLost();
      return;
    }
    this.lastBeatOkAt = this.now();

    const live = new Set(control.liveRunIds());
    const held = new Set(result.held);
    for (const runId of [...this.owned]) {
      if (!liveBefore.has(runId)) continue;
      if (!live.has(runId)) {
        this.owned.delete(runId);
        this.cancelSent.delete(runId);
      } else if (!held.has(runId)) {
        // The sweeper settled it: as far as the ledger is concerned this run is
        // over and its destination is free. Writing on would be the harm.
        control.terminate(runId);
        this.owned.delete(runId);
        this.options.onFenced?.(runId);
      }
    }
    for (const runId of result.cancelling) {
      if (live.has(runId) && !this.cancelSent.has(runId)) void this.cancel(runId);
    }

    if (!this.draining) await this.wake();
  }

  /**
   * Cut off from the database for a whole lease: as far as the ledger may
   * already say, these runs are over and their destinations free. Stopping
   * them is the only safe guess — a partially applied run is reported either
   * way, but two writers into one destination is the harm the lease exists to
   * prevent.
   */
  private selfFenceIfLeaseLost(): void {
    const leaseMs = this.options.leaseMs ?? DEFAULT_LEASE_MS;
    if (this.now() - this.lastBeatOkAt < leaseMs) return;
    for (const runId of [...this.owned]) {
      this.options.control.terminate(runId);
      this.owned.delete(runId);
      this.cancelSent.delete(runId);
      this.options.onFenced?.(runId);
    }
  }

  /**
   * Graceful stop: claim nothing more, let what is running finish for up to
   * `timeoutMs`, then go offline. It never cancels a run on the user's behalf;
   * whatever outlives the grace period is settled by the sweeper.
   */
  async drain(timeoutMs: number): Promise<void> {
    this.draining = true;
    this.clearPoll();
    await this.safely(() => this.options.queue.setState('draining'));
    await this.claiming;

    const deadline = Date.now() + timeoutMs;
    while (this.options.control.liveRunIds().length > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, DRAIN_CHECK_MS));
    }
    await this.stop();
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
    await this.claiming;
    await this.safely(() => this.options.queue.setState('offline'));
    this.options.control.shutdown();
  }

  private async claimLoop(): Promise<void> {
    const { queue, control, slots } = this.options;
    while (!this.draining && control.liveRunIds().length < slots) {
      let claimed: ClaimedRun | null;
      try {
        claimed = await queue.claimNext();
      } catch (err) {
        this.onError(toError(err));
        return;
      }
      if (!claimed) return;
      await this.startRun(claimed);
    }
  }

  private async startRun(claimed: ClaimedRun): Promise<void> {
    const { queue, control } = this.options;
    this.owned.add(claimed.id);

    const sealed = await this.safely(() => queue.takeSpec(claimed.id));
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
    this.owned.delete(runId);
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
