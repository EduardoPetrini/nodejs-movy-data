/**
 * Why a queued run has not started (docs/runner-service-plan.md, "Queue
 * reasons"). Derived when asked, never stored: every one of these changes on
 * its own — a runner comes online, a slot frees, a destination is released —
 * and a stored reason would be stale the moment it was written.
 */

export type QueueReason =
  /** No runner of its class is online. It will wait until one is started. */
  | 'no_runner'
  /** Another run is writing to the same database. */
  | 'destination_busy'
  /** Runners are online, but every slot is taken. */
  | 'runners_busy'
  /** Nothing is in its way: a runner is about to claim it. */
  | 'starting';

export interface QueueState {
  reason: QueueReason;
  runnerClass: string;
  classLabel: string;
  /** This org's runs of the same class queued before it. Never another org's. */
  aheadInOrg: number;
  /**
   * The run holding its destination — only when that run is this org's. Another
   * org's run is that org's business; the run page says only that one exists.
   */
  blockingRunId: string | null;
}

export interface QueueFacts {
  runnerClass: string;
  classLabel: string;
  onlineRunners: number;
  freeSlots: number;
  aheadInOrg: number;
  destinationHeld: boolean;
  blockingRunId: string | null;
}

/**
 * The order is what someone can act on. No runner first: that one never
 * resolves by itself. Then the destination, which is specific and names a run.
 * Busy slots last, since they free up on their own.
 */
export function queueStateOf(f: QueueFacts): QueueState {
  const reason: QueueReason =
    f.onlineRunners === 0 ? 'no_runner'
      : f.destinationHeld ? 'destination_busy'
        : f.freeSlots === 0 ? 'runners_busy'
          : 'starting';
  return {
    reason,
    runnerClass: f.runnerClass,
    classLabel: f.classLabel,
    aheadInOrg: f.aheadInOrg,
    blockingRunId: reason === 'destination_busy' ? f.blockingRunId : null,
  };
}

/** One line for the run page. Pure, so the wording is unit-tested. */
export function queueSentence(q: QueueState): string {
  const ahead = q.aheadInOrg > 0
    ? ` ${q.aheadInOrg} of this organization's runs ${q.aheadInOrg === 1 ? 'is' : 'are'} ahead of it.`
    : '';
  switch (q.reason) {
    case 'no_runner':
      return `Waiting for a runner: no ${q.classLabel} runner is online. It starts as soon as one is.`;
    case 'destination_busy':
      return q.blockingRunId
        ? 'Waiting for the destination: another of this organization\'s runs is writing to the same database.'
        : 'Waiting for the destination: another run is writing to the same database.';
    case 'runners_busy':
      return `Waiting for a free slot: every ${q.classLabel} runner is busy.${ahead}`;
    case 'starting':
      return `Starting: a ${q.classLabel} runner is picking it up.`;
  }
}
