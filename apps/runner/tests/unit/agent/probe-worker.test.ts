import { describe, it, expect } from 'vitest';
import { ProbeWorker, type ProbeQueue } from '../../../src/agent/probe-worker';
import type { ClaimedProbe } from '../../../src/agent/probe-store';
import { ProbeIncompatibleError, type ProbeRequest, type ProbeResult } from '../../../src/probes/probe-wire';

function probe(id: string, kind: 'test' | 'preview' = 'test'): ClaimedProbe {
  return { id, orgId: 'org', kind, ciphertext: Buffer.from(id) };
}

/** A queue of claimable probes that records what was completed. */
function fakeQueue(probes: ClaimedProbe[]) {
  const pending = [...probes];
  const completed: [string, ProbeResult][] = [];
  const queue: ProbeQueue = {
    claim: async () => pending.shift() ?? null,
    complete: async (id, result) => {
      completed.push([id, result]);
      return true;
    },
  };
  return { queue, completed, pending };
}

const testRequest: ProbeRequest = { kind: 'test', config: {} as never };

describe('ProbeWorker', () => {
  it('answers every queued probe with what the executor returned', async () => {
    const { queue, completed } = fakeQueue([probe('a'), probe('b')]);
    const worker = new ProbeWorker({
      queue,
      slots: 2,
      pollIntervalMs: 0,
      open: () => testRequest,
      execute: async () => ({ ok: true, latencyMs: 3 }),
    });

    await worker.wake();
    await worker.stop();

    expect(completed).toEqual([
      ['a', { ok: true, latencyMs: 3 }],
      ['b', { ok: true, latencyMs: 3 }],
    ]);
  });

  it('never runs more probes at once than it has slots', async () => {
    const { queue, completed } = fakeQueue([probe('a'), probe('b'), probe('c')]);
    let running = 0;
    let peak = 0;
    const worker = new ProbeWorker({
      queue,
      slots: 2,
      pollIntervalMs: 0,
      open: () => testRequest,
      execute: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 20));
        running -= 1;
        return { ok: true, latencyMs: 1 };
      },
    });

    await worker.wake();
    expect(worker.busy).toBe(2);
    // A freed slot wakes the worker again, so the third is taken without a poll.
    await expect.poll(() => completed.length).toBe(3);
    await worker.stop();
    expect(peak).toBe(2);
  });

  it('abandons a probe past its deadline: aborts it, answers timeout, and frees the slot', async () => {
    const { queue, completed } = fakeQueue([probe('stuck', 'preview'), probe('next')]);
    let aborted = false;
    const worker = new ProbeWorker({
      queue,
      slots: 1,
      pollIntervalMs: 0,
      deadlineMs: { preview: 20, test: 1_000 },
      open: (_o, id) => (id === 'stuck' ? { kind: 'preview', source: {} as never, target: {} as never } : testRequest),
      execute: (request, signal) => {
        if (request.kind === 'test') return Promise.resolve({ ok: true, latencyMs: 1 });
        // A catalogue query blocked on a lock: it never settles on its own.
        signal.addEventListener('abort', () => { aborted = true; });
        return new Promise<ProbeResult>(() => {});
      },
    });

    await worker.wake();
    await expect.poll(() => completed.length).toBe(2);
    await worker.stop();

    expect(aborted).toBe(true);
    expect(completed[0]).toEqual(['stuck', expect.objectContaining({ ok: false, errorKind: 'timeout' })]);
    expect(completed[1]).toEqual(['next', { ok: true, latencyMs: 1 }]);
  });

  it('stops promptly with a hung probe in flight, rather than waiting on it forever', async () => {
    const { queue, completed } = fakeQueue([probe('stuck')]);
    const worker = new ProbeWorker({
      queue,
      slots: 1,
      pollIntervalMs: 0,
      deadlineMs: { test: 20 },
      open: () => testRequest,
      execute: () => new Promise<ProbeResult>(() => {}),
    });
    await worker.wake();
    await worker.stop();
    expect(completed).toEqual([['stuck', expect.objectContaining({ ok: false, errorKind: 'timeout' })]]);
  });

  it('answers with its own words when it cannot decrypt the request, never the request', async () => {
    const { queue, completed } = fakeQueue([probe('t', 'test'), probe('p', 'preview')]);
    const worker = new ProbeWorker({
      queue,
      slots: 1,
      pollIntervalMs: 0,
      open: () => {
        throw new Error('Unsupported state or unable to authenticate data: hunter2');
      },
    });

    await worker.wake();
    await worker.stop();

    const [[, test], [, preview]] = completed;
    expect(test).toMatchObject({ ok: false, errorKind: 'unknown' });
    expect(preview).toMatchObject({ ok: false, side: null, errorKind: 'unknown' });
    expect(JSON.stringify(completed)).toContain("must share the console's encryption key");
    expect(JSON.stringify(completed)).not.toContain('hunter2');
  });

  it('says which versions disagree when the request is from another release', async () => {
    const { queue, completed } = fakeQueue([probe('t')]);
    const worker = new ProbeWorker({
      queue,
      slots: 1,
      pollIntervalMs: 0,
      open: () => {
        throw new ProbeIncompatibleError('This probe is version 9; this runner understands 1.');
      },
    });

    await worker.wake();
    await worker.stop();
    expect(completed[0][1]).toMatchObject({ ok: false, error: 'This probe is version 9; this runner understands 1.' });
  });

  it('takes nothing with no probe slots, and nothing once stopped', async () => {
    const none = fakeQueue([probe('a')]);
    await new ProbeWorker({ queue: none.queue, slots: 0, pollIntervalMs: 0 }).wake();
    expect(none.pending).toHaveLength(1);

    const stopped = fakeQueue([probe('a')]);
    const worker = new ProbeWorker({ queue: stopped.queue, slots: 1, pollIntervalMs: 0 });
    await worker.stop();
    await worker.wake();
    expect(stopped.pending).toHaveLength(1);
  });

  it('survives a failed claim and a failed completion, reporting both', async () => {
    const errors: string[] = [];
    let claims = 0;
    const worker = new ProbeWorker({
      queue: {
        claim: async () => {
          claims += 1;
          if (claims === 1) throw new Error('meta-db blip');
          return claims === 2 ? probe('a') : null;
        },
        complete: async () => {
          throw new Error('write failed');
        },
      },
      slots: 1,
      pollIntervalMs: 0,
      open: () => testRequest,
      execute: async () => ({ ok: true, latencyMs: 1 }),
      onError: (err) => errors.push(err.message),
    });

    await worker.wake();
    await worker.wake();
    await worker.stop();
    expect(errors).toEqual(['meta-db blip', 'write failed']);
  });
});
