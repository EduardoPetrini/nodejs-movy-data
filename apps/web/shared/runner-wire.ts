/**
 * The runner-availability wire contract (docs/runner-service-plan.md, phase 3).
 * One declaration for both halves, like `run-wire.ts`.
 */

/** One runner class as an org member sees it. Counts only: no ids, no hosts. */
export interface RunnerClassSummary {
  name: string;
  label: string;
  description: string | null;
  isDefault: boolean;
  /** Runners of this class heartbeating now. */
  online: number;
  draining: number;
  /** Run slots across the online runners, and how many are free. */
  totalSlots: number;
  freeSlots: number;
  /**
   * Runs of THIS org waiting for this class. Runners are shared across orgs
   * (decision 3), but another org's queue is that org's business.
   */
  queued: number;
}

/** One runner, as an org admin sees it. Never sent to anyone else. */
export interface RunnerDetail {
  id: string;
  runnerClass: string;
  state: 'online' | 'draining' | 'offline';
  version: string;
  slots: number;
  busy: number;
  lastHeartbeatAt: string;
}

export interface RunnersSnapshot {
  classes: RunnerClassSummary[];
  /** Present for admins only. */
  runners?: RunnerDetail[];
  at: string;
}

/** Server -> client on `/_ws/runners`. */
export type RunnersServerFrame =
  | ({ k: 'runners' } & RunnersSnapshot)
  | { k: 'hello' }
  | { k: 'error'; message: string }
  | { k: 'revoked'; reason: string };

/** What the panel says about a class. Pure, so it is unit-tested. */
export type ClassAvailability = 'free' | 'busy' | 'none' | 'draining';

export function availabilityOf(c: RunnerClassSummary): ClassAvailability {
  if (c.online === 0) return c.draining > 0 ? 'draining' : 'none';
  return c.freeSlots > 0 ? 'free' : 'busy';
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The one line the panel shows for a class. Says what will happen to a run
 * launched now — claimed at once, queued behind others, or waiting for a runner
 * that is not there — rather than reciting numbers.
 */
export function classSentence(c: RunnerClassSummary): string {
  const waiting = c.queued > 0 ? ` · ${c.queued} of your runs waiting` : '';
  switch (availabilityOf(c)) {
    case 'none':
      return `No runner online${waiting}`;
    case 'draining':
      return `Draining · finishing its runs, taking no new ones${waiting}`;
    case 'busy':
      return (c.totalSlots === 1 ? 'Its only slot is busy' : `All ${c.totalSlots} slots busy`) + waiting;
    case 'free':
      return `${c.freeSlots} of ${plural(c.totalSlots, 'slot', 'slots')} free${waiting}`;
  }
}

/**
 * The answer to "Start a runner" (`POST …/runners/scale`). Which one depends
 * on the deployment's provisioner, not on the request.
 */
export type ScaleResult =
  /** A runner is starting; it shows up in the panel once it registers. */
  | { status: 'started'; runnerClass: string; container: string }
  /** This deployment starts runners by hand: here is the command. */
  | { status: 'manual'; runnerClass: string; command: string }
  /** Already at the class's `max_replicas`; nothing was started. */
  | { status: 'at_capacity'; runnerClass: string; maxReplicas: number };

/** One line for what "Start a runner" did. Pure, so the wording is unit-tested. */
export function scaleSentence(result: ScaleResult, classLabel: string): string {
  switch (result.status) {
    case 'started':
      return `Starting a ${classLabel} runner (${result.container}). It is listed as online once it has registered, usually within a few seconds.`;
    case 'manual':
      return `This deployment starts runners by hand. Run this to start a ${classLabel} runner:`;
    case 'at_capacity':
      return `The ${classLabel} class is already at its limit of ${result.maxReplicas} ${result.maxReplicas === 1 ? 'runner' : 'runners'}.`;
  }
}
