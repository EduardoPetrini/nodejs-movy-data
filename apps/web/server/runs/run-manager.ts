import { fork } from 'node:child_process';
import * as fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { RUNNER_EXIT, isHostToRunner } from '@movy/runner/protocol';
import type { RunnerToHost } from '@movy/runner/protocol';
import type { MigrationEvent } from '@movy/core';
import type { EventWriter } from './event-writer';
import { isProcessAlive, readJournalAfter } from './journal-tailer';

/** What the manager needs of the database. Narrow, so it fakes in a test. */
export interface RunManagerStore {
  markLaunched(runId: string, info: { pid: number; journalPath: string }): Promise<void>;
  finaliseIfUnsettled(
    runId: string,
    outcome: { status: 'succeeded' | 'failed' | 'cancelled'; errorName?: string; errorMessage?: string }
  ): Promise<boolean>;
  unsettledRuns(): Promise<readonly UnsettledRun[]>;
}

export interface LaunchRequest {
  readonly runId: string;
  readonly journalPath: string;
  /** Serialised on the caller's side; carries two passwords, so never logged. */
  readonly spec: unknown;
  /** Replay a recording instead of touching a database. */
  readonly simulateFixture?: string;
  readonly speed?: number;
}

export interface RunManagerOptions {
  /** Absolute path to the runner entry point. `.ts` is loaded through tsx. */
  readonly runnerEntry: string;
  readonly spawn?: (entry: string, argv: string[], journalPath: string) => ChildProcess;
  readonly onError?: (err: Error, runId: string) => void;
  /** How often to re-read an orphan's journal. */
  readonly followIntervalMs?: number;
}

/** One run this host is watching through its journal because IPC is gone. */
export interface UnsettledRun {
  readonly id: string;
  readonly pid: number | null;
  readonly journalPath: string;
  readonly lastSeq: number;
}

/** How a run ended, as the manager reports it when no event said so. */
interface Outcome {
  readonly status: 'succeeded' | 'failed' | 'cancelled';
  readonly errorName?: string;
  readonly errorMessage?: string;
}

interface Handle {
  readonly runId: string;
  readonly child: ChildProcess;
  pid: number | null;
  /** Set the moment `run_finished` is seen, so exit does not re-settle it. */
  sawTerminal: boolean;
}

const EXIT_STATUS: Record<number, 'succeeded' | 'failed' | 'cancelled'> = {
  [RUNNER_EXIT.succeeded]: 'succeeded',
  [RUNNER_EXIT.failed]: 'failed',
  [RUNNER_EXIT.cancelled]: 'cancelled',
};

/**
 * Supervises runner processes for this Nitro instance.
 *
 * Deliberately not the owner of run state. The runner is forked `detached` and
 * outlives this process, so anything the manager holds in memory is a cache of
 * what the journal and the database already say. A restart loses every handle
 * and loses no run — `reattach()` is what proves it.
 */
export class RunManager {
  private readonly handles = new Map<string, Handle>();
  /** Orphans being followed through their journals: runId -> poll timer. */
  private readonly followers = new Map<string, NodeJS.Timeout>();
  private readonly followIntervalMs: number;
  private readonly runnerEntry: string;
  private readonly spawn: NonNullable<RunManagerOptions['spawn']>;
  private readonly onError: (err: Error, runId: string) => void;

  constructor(
    private readonly store: RunManagerStore,
    private readonly writer: EventWriter,
    options: RunManagerOptions
  ) {
    this.runnerEntry = options.runnerEntry;
    this.followIntervalMs = options.followIntervalMs ?? 1000;
    this.onError = options.onError ?? (() => {});
    this.spawn = options.spawn ?? defaultSpawn;
  }

  launch(request: LaunchRequest): void {
    const argv = ['--journal', request.journalPath, '--run-id', request.runId];
    if (request.simulateFixture) {
      argv.push('--simulate', request.simulateFixture);
      if (request.speed !== undefined) argv.push('--speed', String(request.speed));
    }

    const child = this.spawn(this.runnerEntry, argv, request.journalPath);
    const handle: Handle = { runId: request.runId, child, pid: child.pid ?? null, sawTerminal: false };
    this.handles.set(request.runId, handle);

    child.on('message', (message: unknown) => this.onMessage(handle, message));
    child.on('error', (err) => this.onError(err, request.runId));
    child.on('exit', (code, signal) => void this.onExit(handle, code, signal));

    // The spec goes on stdin and stdin is closed straight away: argv is
    // world-readable through `ps` and this object carries two database
    // passwords. Simulation has no spec, but the runner still waits for EOF.
    const stdin = child.stdin;
    if (stdin) {
      if (!request.simulateFixture) stdin.write(JSON.stringify(request.spec));
      stdin.end();
    }

    // Detached and unref'd: a Nitro restart must not take a live migration
    // with it. The run keeps writing its journal; the host re-attaches to it.
    child.unref();
  }

  /**
   * Cooperative, and best-effort by design. The IPC message is preferred so the
   * runner aborts at a step boundary; SIGTERM is the fallback for a run this
   * process did not fork, which is the normal case after a restart.
   */
  async cancel(runId: string, pid: number | null): Promise<boolean> {
    const handle = this.handles.get(runId);
    if (handle && handle.child.connected) {
      handle.child.send({ k: 'cancel' });
      return true;
    }

    const target = handle?.pid ?? pid;
    if (!isProcessAlive(target)) {
      // Nothing left to signal: settle it here rather than leave the UI
      // waiting on a process that exited while nobody was attached.
      await this.store.finaliseIfUnsettled(runId, {
        status: 'cancelled',
        errorName: 'RunnerGone',
        errorMessage: 'The runner process was no longer running when cancellation was requested.',
      });
      return false;
    }

    try {
      process.kill(target!, 'SIGTERM');
      return true;
    } catch (err) {
      this.onError(err instanceof Error ? err : new Error(String(err)), runId);
      return false;
    }
  }

  /**
   * Boot recovery, then continuous follow.
   *
   * The runner is forked `detached`, so a deploy or a crash leaves live
   * migrations running with nobody listening — and IPC can never be
   * re-established, because the channel died with the old process. The journal
   * is the only way back in.
   *
   * For each run without an outcome: replay from the stored `seq` cursor, then
   * either settle it (the journal says how it ended, or the process is gone) or
   * KEEP FOLLOWING it. A one-shot read would leave a still-running orphan
   * invisible until the next boot, which is the same as losing it.
   *
   * Re-delivered events are not a problem: `run_events` is keyed on
   * `(run_id, seq)`, so re-inserting one is a no-op.
   */
  async reattach(): Promise<{ recovered: number; settled: number; following: number }> {
    const unsettled = await this.store.unsettledRuns();
    let recovered = 0;
    let settled = 0;
    let following = 0;

    for (const run of unsettled) {
      const caught = await this.catchUp(run, run.lastSeq);
      if (caught.read > 0) recovered += 1;

      if (caught.outcome) {
        if (await this.settleRun(run.id, caught.outcome)) settled += 1;
      } else {
        this.follow(run, caught.cursor);
        following += 1;
      }
    }

    return { recovered, settled, following };
  }

  /**
   * One pass over a journal. Returns an outcome when the run is over — either
   * because the journal says so, or because the process that owned it is gone.
   *
   * Aliveness is sampled BEFORE the read, deliberately: a process that dies
   * mid-pass then has its last events read by this very pass, so nothing is
   * settled ahead of the events that explain it.
   */
  private async catchUp(
    run: UnsettledRun,
    fromSeq: number
  ): Promise<{ read: number; cursor: number; outcome: Outcome | null }> {
    const aliveBefore = isProcessAlive(run.pid);
    let terminal: Extract<MigrationEvent, { type: 'run_finished' }> | null = null;
    let read = 0;
    let cursor = fromSeq;

    try {
      const result = await readJournalAfter(run.journalPath, fromSeq, (event) => {
        this.writer.push(run.id, event);
        if (event.type === 'run_finished') terminal = event;
      });
      read = result.read;
      cursor = result.lastSeq;
    } catch (err) {
      this.onError(toError(err), run.id);
    }

    // Flush before settling, so the terminal event is stored by the time the
    // run row claims an outcome. The other order lets a client see a finished
    // run whose timeline is still missing its last events.
    await this.writer.flush(run.id);

    if (terminal !== null) {
      const event = terminal as Extract<MigrationEvent, { type: 'run_finished' }>;
      return {
        read,
        cursor,
        outcome: { status: event.status, errorName: event.error?.name, errorMessage: event.error?.message },
      };
    }

    if (!aliveBefore) {
      return {
        read,
        cursor,
        outcome: {
          status: 'failed',
          errorName: 'RunnerVanished',
          errorMessage:
            'The runner process is no longer running and its journal has no outcome. The migration may be partially applied.',
        },
      };
    }

    return { read, cursor, outcome: null };
  }

  /** Poll an orphan's journal until it ends. Idempotent per run. */
  private follow(run: UnsettledRun, fromSeq: number): void {
    if (this.followers.has(run.id)) return;

    let cursor = fromSeq;
    let busy = false;

    const tick = async (): Promise<void> => {
      // A slow pass must not overlap the next tick and re-read the same range.
      if (busy) return;
      busy = true;
      try {
        const caught = await this.catchUp(run, cursor);
        cursor = caught.cursor;
        if (caught.outcome) {
          this.unfollow(run.id);
          await this.settleRun(run.id, caught.outcome);
        }
      } finally {
        busy = false;
      }
    };

    const timer = setInterval(() => void tick(), this.followIntervalMs);
    // Following an orphan must not be what keeps the host alive at shutdown.
    timer.unref?.();
    this.followers.set(run.id, timer);
  }

  private unfollow(runId: string): void {
    const timer = this.followers.get(runId);
    if (timer === undefined) return;
    clearInterval(timer);
    this.followers.delete(runId);
  }

  private async settleRun(runId: string, outcome: Outcome): Promise<boolean> {
    try {
      return await this.store.finaliseIfUnsettled(runId, outcome);
    } catch (err) {
      this.onError(toError(err), runId);
      return false;
    }
  }

  /** Detach from every child without killing it. Runs outlive the host. */
  shutdown(): void {
    for (const runId of [...this.followers.keys()]) this.unfollow(runId);
    for (const handle of this.handles.values()) {
      handle.child.removeAllListeners();
      handle.child.disconnect?.();
    }
    this.handles.clear();
  }

  private onMessage(handle: Handle, message: unknown): void {
    const parsed = message as RunnerToHost | undefined;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.k !== 'string') return;
    // Guards against the host's own protocol shape echoing back as a message.
    if (isHostToRunner(parsed)) return;

    switch (parsed.k) {
      case 'ready':
        handle.pid = parsed.pid;
        void this.store
          .markLaunched(handle.runId, { pid: parsed.pid, journalPath: parsed.journalPath })
          .catch((err: unknown) => this.onError(toError(err), handle.runId));
        break;

      case 'event':
        if (parsed.event.type === 'run_finished') handle.sawTerminal = true;
        this.writer.push(handle.runId, parsed.event);
        break;

      case 'fatal':
        // The run never started, or could not be recorded at all. There is no
        // event stream to take an outcome from, so the message is the outcome.
        void this.settle(handle, { status: 'failed', errorName: 'RunnerFatal', errorMessage: parsed.message });
        break;
    }
  }

  private async onExit(handle: Handle, code: number | null, signal: string | null): Promise<void> {
    this.handles.delete(handle.runId);
    await this.writer.flush(handle.runId);

    // The event is always better than the exit code — it carries the error and
    // the duration. Only fall back when the process left without one.
    if (handle.sawTerminal) return;

    const mapped = code === null ? undefined : EXIT_STATUS[code];
    if (mapped) {
      await this.settle(handle, { status: mapped });
      return;
    }

    await this.settle(handle, {
      status: 'failed',
      errorName: 'RunnerExited',
      errorMessage:
        code === RUNNER_EXIT.usage
          ? 'The runner rejected the run specification.'
          : `The runner exited without reporting an outcome (code ${code ?? 'none'}${signal ? `, signal ${signal}` : ''}).`,
    });
  }

  private async settle(handle: Handle, outcome: Outcome): Promise<void> {
    await this.settleRun(handle.runId, outcome);
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * `.ts` entry points are loaded through tsx so `pnpm dev:web` can launch a run
 * without a build step; a built `.js` entry is forked directly.
 *
 * stderr goes to a file beside the journal rather than being INHERITED. A
 * detached child that holds the host's stderr descriptor is tied to the host
 * after all — the fd outlives the process only until something writes to it
 * and gets EPIPE. A file keeps the crash diagnostics, which is the only reason
 * to want stderr from a process nobody is watching.
 */
function defaultSpawn(entry: string, argv: string[], journalPath: string): ChildProcess {
  const execArgv = entry.endsWith('.ts') ? ['--import', 'tsx'] : [];
  const stderr = fs.openSync(`${journalPath}.stderr.log`, 'a');
  try {
    return fork(entry, argv, {
      detached: true,
      execArgv,
      stdio: ['pipe', 'ignore', stderr, 'ipc'],
    });
  } finally {
    // The child holds its own duplicate; the host must not keep this one open.
    fs.closeSync(stderr);
  }
}
