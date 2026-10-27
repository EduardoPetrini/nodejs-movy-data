import { describe, it, expect } from 'vitest';
import { ProbeWaiters } from '../../server/probes/probe-waiters';

describe('ProbeWaiters', () => {
  it('wakes every waiter on that probe, and only that probe', async () => {
    const waiters = new ProbeWaiters();
    const woke: string[] = [];
    const a = waiters.next('a', 10_000).then(() => woke.push('a'));
    void waiters.next('b', 10_000).then(() => woke.push('b'));

    waiters.notify('a');
    await a;
    expect(woke).toEqual(['a']);
    expect(waiters.size).toBe(1);
    waiters.notifyAll();
    await expect.poll(() => woke).toEqual(['a', 'b']);
    expect(waiters.size).toBe(0);
  });

  it('wakes on its own when no notification comes — a missed NOTIFY is never a hang', async () => {
    const waiters = new ProbeWaiters();
    const started = Date.now();
    await waiters.next('a', 20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    expect(waiters.size).toBe(0);
  });
});
