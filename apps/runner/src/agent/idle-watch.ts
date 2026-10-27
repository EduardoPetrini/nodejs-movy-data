/**
 * When a provisioned runner has had nothing to do for long enough to leave.
 *
 * Only provisioned runners use it: a baseline replica is the capacity the
 * deployment promised and never removes itself. Idle means no run AND no probe
 * — a runner answering Test for someone is in use. Time is passed in, so the
 * rule is testable without waiting ten minutes.
 */
export class IdleWatch {
  private idleSince: number;

  constructor(
    private readonly idleExitMs: number,
    now: number
  ) {
    this.idleSince = now;
  }

  /** Records what is running now; true once it has been idle for `idleExitMs`. */
  observe(busy: number, now: number): boolean {
    if (busy > 0) {
      this.idleSince = now;
      return false;
    }
    return now - this.idleSince >= this.idleExitMs;
  }
}
