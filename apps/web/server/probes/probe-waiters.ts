/**
 * Wakes the request waiting on a probe when `NOTIFY movy_probe_done` arrives.
 *
 * Only ever a hint: a notification can be missed (the LISTEN connection
 * dropped) or arrive at a replica that is not the one waiting, so the waiter
 * also wakes on its own after `maxWaitMs` and re-reads the row.
 */
export class ProbeWaiters {
  private readonly waiting = new Map<string, Set<() => void>>();

  /** Resolves on `notify(probeId)` or after `maxWaitMs`, whichever is first. */
  next(probeId: string, maxWaitMs: number): Promise<void> {
    return new Promise((resolve) => {
      const set = this.waiting.get(probeId) ?? new Set<() => void>();
      this.waiting.set(probeId, set);
      const done = (): void => {
        clearTimeout(timer);
        set.delete(done);
        if (set.size === 0) this.waiting.delete(probeId);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, maxWaitMs));
      set.add(done);
    });
  }

  notify(probeId: string): void {
    for (const done of [...(this.waiting.get(probeId) ?? [])]) done();
  }

  /** After a LISTEN reconnect: anything may have finished meanwhile. */
  notifyAll(): void {
    for (const id of [...this.waiting.keys()]) this.notify(id);
  }

  get size(): number {
    return this.waiting.size;
  }
}
