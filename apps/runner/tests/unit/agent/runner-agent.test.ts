import { describe, it, expect, vi, afterEach } from 'vitest';
import { RunnerAgent, type AgentQueue, type AgentRunControl } from '../../../src/agent/runner-agent';
import { RunSpecIncompatibleError, type RunSpecEnvelope } from '../../../src/agent/run-spec-envelope';
import type { ClaimedRun, HeartbeatResult, SealedSpec, Settlement } from '../../../src/agent/queue-store';
import type { LaunchRequest } from '../../../src/agent/run-manager';

const ORG = '11111111-1111-1111-1111-111111111111';

/** A queue holding whatever runs the test puts in it, sealed as plain JSON. */
function fakeQueue(queued: ClaimedRun[] = [], specs: Record<string, RunSpecEnvelope | 'missing' | number> = {}) {
  const settled: { runId: string; outcome: Settlement }[] = [];
  const states: string[] = [];
  let beat: HeartbeatResult = { held: [], cancelling: [] };
  const queue: AgentQueue = {
    register: vi.fn(async () => {}),
    setState: vi.fn(async (s) => { states.push(s); }),
    claimNext: vi.fn(async () => queued.shift() ?? null),
    takeSpec: vi.fn(async (runId): Promise<SealedSpec | null> => {
      const spec = specs[runId] ?? { simulate: false, spec: { runId } };
      if (spec === 'missing') return null;
      if (typeof spec === 'number') return { specVersion: spec, ciphertext: Buffer.from('{}') };
      return { specVersion: 1, ciphertext: Buffer.from(JSON.stringify(spec)) };
    }),
    heartbeat: vi.fn(async () => beat),
    settle: vi.fn(async (runId, outcome) => { settled.push({ runId, outcome }); return true; }),
  };
  return { queue, settled, states, setBeat: (b: HeartbeatResult) => { beat = b; }, queued };
}

/** RunManager as the agent sees it: runs stay live until the test ends them. */
function fakeControl() {
  const live = new Set<string>();
  const launched: LaunchRequest[] = [];
  const control: AgentRunControl = {
    launch: vi.fn((req: LaunchRequest) => { launched.push(req); live.add(req.runId); }),
    cancel: vi.fn(async () => true),
    terminate: vi.fn((runId: string) => live.delete(runId)),
    liveRunIds: () => [...live],
    reattach: vi.fn(async () => ({ recovered: 0, settled: 0, following: 0 })),
    shutdown: vi.fn(),
  };
  return { control, launched, live, finish: (runId: string) => live.delete(runId) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Lets every already-settled promise continuation run. */
function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

function run(id: string): ClaimedRun {
  return { id, orgId: ORG, simulated: false };
}

function agentWith(q: ReturnType<typeof fakeQueue>, c: ReturnType<typeof fakeControl>, slots = 1, fixture?: string) {
  return new RunnerAgent({
    queue: q.queue,
    control: c.control,
    slots,
    journalPathFor: (id) => `/journals/${id}.ndjson`,
    simulationFixture: () => fixture,
    // Fake sealing: the envelope is the plaintext JSON. Real sealing is tested
    // in run-spec-envelope.test.ts.
    openSpec: (_org, _run, sealed) => {
      if (sealed.specVersion !== 1) throw new RunSpecIncompatibleError(sealed.specVersion);
      return JSON.parse(sealed.ciphertext.toString()) as RunSpecEnvelope;
    },
    pollIntervalMs: 0,
    heartbeatIntervalMs: 0,
  });
}

describe('RunnerAgent claiming', () => {
  it('fills its slots and no more', async () => {
    const q = fakeQueue([run('a'), run('b'), run('c')]);
    const c = fakeControl();
    await agentWith(q, c, 2).start();

    expect(c.launched.map((l) => l.runId)).toEqual(['a', 'b']);
    expect(q.queued.map((r) => r.id)).toEqual(['c']);
  });

  it('claims again on the next beat once a slot frees', async () => {
    const q = fakeQueue([run('a'), run('b')]);
    const c = fakeControl();
    const agent = agentWith(q, c, 1);
    await agent.start();
    c.finish('a');
    q.setBeat({ held: [], cancelling: [] });

    await agent.beat();

    expect(c.launched.map((l) => l.runId)).toEqual(['a', 'b']);
  });

  it('re-attaches and heartbeats before it claims anything', async () => {
    // The first heartbeat extends leases on the runs it owned before a restart,
    // ahead of any sweeper; claiming first could let those expire meanwhile.
    const q = fakeQueue([run('a')]);
    const c = fakeControl();
    const order: string[] = [];
    (c.control.reattach as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('reattach'); return { recovered: 0, settled: 0, following: 0 }; });
    (q.queue.heartbeat as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('beat'); return { held: [], cancelling: [] }; });
    (q.queue.claimNext as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { order.push('claim'); return run('a'); });

    await agentWith(q, c).start();

    expect(order.slice(0, 3)).toEqual(['reattach', 'beat', 'claim']);
  });

  it('hands a real spec to the runner and keeps it out of everything else', async () => {
    const spec = { simulate: false as const, spec: { source: { password: 'hunter2' } } };
    const q = fakeQueue([run('a')], { a: spec });
    const c = fakeControl();
    await agentWith(q, c).start();

    expect(c.launched[0]).toEqual({ runId: 'a', journalPath: '/journals/a.ndjson', spec: spec.spec });
  });

  it('replays the fixture on its own host for a simulated run', async () => {
    const q = fakeQueue([run('a')], { a: { simulate: true, speed: 0.25 } });
    const c = fakeControl();
    await agentWith(q, c, 1, '/fixtures/pg.ndjson').start();

    expect(c.launched[0]).toMatchObject({ simulateFixture: '/fixtures/pg.ndjson', speed: 0.25, spec: undefined });
  });
});

describe('RunnerAgent refusing a run it cannot start', () => {
  it.each([
    ['a missing spec', 'missing' as const, 'RunSpecMissing'],
    ['an unknown spec version', 7, 'RunnerIncompatible'],
  ])('settles %s as failed, by name', async (_label, spec, errorName) => {
    const q = fakeQueue([run('a')], { a: spec });
    const c = fakeControl();
    await agentWith(q, c).start();

    expect(c.launched).toEqual([]);
    expect(q.settled).toEqual([{ runId: 'a', outcome: expect.objectContaining({ status: 'failed', errorName }) }]);
  });

  it('says the database failed, not that the spec was gone, when reading it errors', async () => {
    const q = fakeQueue([run('a')]);
    (q.queue.takeSpec as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('connection reset'));
    const c = fakeControl();
    await agentWith(q, c).start();

    expect(c.launched).toEqual([]);
    expect(q.settled).toEqual([
      { runId: 'a', outcome: expect.objectContaining({ status: 'failed', errorName: 'RunSpecUnavailable' }) },
    ]);
  });

  it('settles a simulation it has no recording for', async () => {
    const q = fakeQueue([run('a')], { a: { simulate: true } });
    const c = fakeControl();
    await agentWith(q, c, 1, undefined).start();

    expect(q.settled[0].outcome.errorName).toBe('NoSimulationFixture');
  });

  it('settles a spec it cannot decrypt without saying anything about its content', async () => {
    const q = fakeQueue([run('a')]);
    const c = fakeControl();
    const agent = new RunnerAgent({
      queue: q.queue, control: c.control, slots: 1,
      journalPathFor: () => '/j', simulationFixture: () => undefined,
      openSpec: () => { throw new Error('Unsupported state or unable to authenticate data'); },
      pollIntervalMs: 0, heartbeatIntervalMs: 0,
    });
    await agent.start();

    expect(q.settled[0].outcome).toMatchObject({ errorName: 'RunSpecUnreadable' });
    expect(q.settled[0].outcome.errorMessage).toMatch(/encryption key/);
  });

  it('goes on to the next queued run after refusing one', async () => {
    const q = fakeQueue([run('bad'), run('good')], { bad: 'missing' });
    const c = fakeControl();
    await agentWith(q, c).start();
    expect(c.launched.map((l) => l.runId)).toEqual(['good']);
  });
});

describe('RunnerAgent leases', () => {
  it('fences a run whose lease it lost: stops it at once', async () => {
    const q = fakeQueue([run('a')]);
    const c = fakeControl();
    const onFenced = vi.fn();
    const agent = new RunnerAgent({
      queue: q.queue, control: c.control, slots: 1,
      journalPathFor: () => '/j', simulationFixture: () => undefined,
      openSpec: (_o, _r, s) => JSON.parse(s.ciphertext.toString()),
      pollIntervalMs: 0, heartbeatIntervalMs: 0, onFenced,
    });
    await agent.start();

    q.setBeat({ held: [], cancelling: [] }); // the sweeper settled it
    await agent.beat();

    expect(c.control.terminate).toHaveBeenCalledWith('a');
    expect(onFenced).toHaveBeenCalledWith('a');
  });

  it('leaves a run alone while it still holds the lease', async () => {
    const q = fakeQueue([run('a')]);
    const c = fakeControl();
    const agent = agentWith(q, c);
    await agent.start();
    q.setBeat({ held: ['a'], cancelling: [] });
    await agent.beat();
    expect(c.control.terminate).not.toHaveBeenCalled();
  });

  it('never fences a run it did not claim, such as one forked before migration 0004', async () => {
    const q = fakeQueue();
    const c = fakeControl();
    c.live.add('legacy');
    await agentWith(q, c).start();
    await agentWith(q, c).beat();
    expect(c.control.terminate).not.toHaveBeenCalled();
  });

  it('forwards a cancel it learns of from the heartbeat, once', async () => {
    const q = fakeQueue([run('a')]);
    const c = fakeControl();
    const agent = agentWith(q, c);
    await agent.start();
    q.setBeat({ held: ['a'], cancelling: ['a'] });

    await agent.beat();
    await agent.beat();

    expect(c.control.cancel).toHaveBeenCalledTimes(1);
    expect(c.control.cancel).toHaveBeenCalledWith('a', null);
  });

  it('does not fence a run claimed and launched while the heartbeat was in flight', async () => {
    // The heartbeat's snapshot predates the claim, so `held` cannot name the
    // run yet; that is not the sweeper settling it.
    const q = fakeQueue();
    const c = fakeControl();
    const agent = agentWith(q, c);
    await agent.start();
    const beatAnswer = deferred<HeartbeatResult>();
    (q.queue.heartbeat as ReturnType<typeof vi.fn>).mockImplementationOnce(() => beatAnswer.promise);

    const beating = agent.beat();
    q.queued.push(run('b'));
    await agent.wake();
    expect(c.live.has('b')).toBe(true);
    beatAnswer.resolve({ held: [], cancelling: [] });
    await beating;

    expect(c.control.terminate).not.toHaveBeenCalled();
  });

  it('still fences a run whose launch straddled a heartbeat, once its lease is lost', async () => {
    // Claimed before the beat answered, launched after it: the beat must not
    // forget the run, or it is never fenced at all.
    const q = fakeQueue();
    const c = fakeControl();
    const onFenced = vi.fn();
    const agent = new RunnerAgent({
      queue: q.queue, control: c.control, slots: 1,
      journalPathFor: () => '/j', simulationFixture: () => undefined,
      openSpec: (_o, _r, s) => JSON.parse(s.ciphertext.toString()),
      pollIntervalMs: 0, heartbeatIntervalMs: 0, onFenced,
    });
    await agent.start();
    const spec = deferred<SealedSpec | null>();
    (q.queue.takeSpec as ReturnType<typeof vi.fn>).mockImplementationOnce(() => spec.promise);

    q.queued.push(run('b'));
    const claiming = agent.wake();
    await flush();
    q.setBeat({ held: ['b'], cancelling: [] });
    const beating = agent.beat();
    await flush();
    spec.resolve({ specVersion: 1, ciphertext: Buffer.from(JSON.stringify({ simulate: false, spec: {} })) });
    await Promise.all([claiming, beating]);
    expect(c.live.has('b')).toBe(true);

    q.setBeat({ held: [], cancelling: [] }); // the sweeper settled it
    await agent.beat();

    expect(c.control.terminate).toHaveBeenCalledWith('b');
    expect(onFenced).toHaveBeenCalledWith('b');
  });

  it('survives a failed heartbeat, since the lease outlasts several', async () => {
    const q = fakeQueue();
    const c = fakeControl();
    const onError = vi.fn();
    (q.queue.heartbeat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('connection reset'));
    const agent = new RunnerAgent({
      queue: q.queue, control: c.control, slots: 1,
      journalPathFor: () => '/j', simulationFixture: () => undefined,
      pollIntervalMs: 0, heartbeatIntervalMs: 0, onError,
    });
    await expect(agent.start()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });
});

describe('RunnerAgent cut off from the database', () => {
  function cutOff(q: ReturnType<typeof fakeQueue>, c: ReturnType<typeof fakeControl>, clock: { t: number }) {
    return new RunnerAgent({
      queue: q.queue, control: c.control, slots: 1,
      journalPathFor: () => '/j', simulationFixture: () => undefined,
      openSpec: (_o, _r, sealed) => JSON.parse(sealed.ciphertext.toString()) as RunSpecEnvelope,
      pollIntervalMs: 0, heartbeatIntervalMs: 0, leaseCheckIntervalMs: 0, leaseMs: 30_000, fenceMarginMs: 5_000, now: () => clock.t,
    });
  }

  it('keeps running through failed beats while the lease could still be alive', async () => {
    const clock = { t: 0 };
    const q = fakeQueue([run('a')]);
    const c = fakeControl();
    const agent = cutOff(q, c, clock);
    q.setBeat({ held: ['a'], cancelling: [] });
    await agent.start();
    (q.queue.heartbeat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNREFUSED'));

    clock.t = 24_000;
    await agent.beat();

    expect(c.control.terminate).not.toHaveBeenCalled();
  });

  it('stops its own runs BEFORE their lease can expire, since the sweeper may then settle them', async () => {
    const clock = { t: 0 };
    const q = fakeQueue([run('a')]);
    const c = fakeControl();
    const onFenced = vi.fn();
    const agent = new RunnerAgent({
      queue: q.queue, control: c.control, slots: 1,
      journalPathFor: () => '/j', simulationFixture: () => undefined,
      openSpec: (_o, _r, sealed) => JSON.parse(sealed.ciphertext.toString()) as RunSpecEnvelope,
      pollIntervalMs: 0, heartbeatIntervalMs: 0, leaseCheckIntervalMs: 0, leaseMs: 30_000, fenceMarginMs: 5_000, now: () => clock.t, onFenced,
    });
    q.setBeat({ held: ['a'], cancelling: [] });
    await agent.start();
    (q.queue.heartbeat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNREFUSED'));

    clock.t = 25_000;
    await agent.beat();

    expect(c.control.terminate).toHaveBeenCalledWith('a');
    expect(onFenced).toHaveBeenCalledWith('a');
  });

  it('measures the lease from the last beat that landed, not from start', async () => {
    const clock = { t: 0 };
    const q = fakeQueue([run('a')]);
    const c = fakeControl();
    const agent = cutOff(q, c, clock);
    q.setBeat({ held: ['a'], cancelling: [] });
    await agent.start();
    clock.t = 20_000;
    await agent.beat();
    (q.queue.heartbeat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNREFUSED'));

    clock.t = 44_000;
    await agent.beat();

    expect(c.control.terminate).not.toHaveBeenCalled();
  });

  it('fences on its deadline while a heartbeat hangs, without waiting for the query to fail', async () => {
    // A blackholed connection: the heartbeat neither answers nor rejects.
    const clock = { t: 0 };
    const q = fakeQueue([run('a')]);
    const c = fakeControl();
    const agent = cutOff(q, c, clock);
    q.setBeat({ held: ['a'], cancelling: [] });
    await agent.start();
    (q.queue.heartbeat as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}));

    clock.t = 5_000;
    void agent.beat();
    clock.t = 24_000;
    agent.checkLeases();
    expect(c.control.terminate).not.toHaveBeenCalled();

    clock.t = 25_000;
    agent.checkLeases();
    expect(c.control.terminate).toHaveBeenCalledWith('a');
  });

  it('measures a lease from when its renewal was SENT, so a slow answer cannot stretch it', async () => {
    const clock = { t: 0 };
    const q = fakeQueue([run('a')]);
    const c = fakeControl();
    const agent = cutOff(q, c, clock);
    q.setBeat({ held: ['a'], cancelling: [] });
    await agent.start();
    const answer = deferred<HeartbeatResult>();
    (q.queue.heartbeat as ReturnType<typeof vi.fn>).mockImplementationOnce(() => answer.promise);

    clock.t = 10_000;
    const beating = agent.beat();
    clock.t = 30_000; // answered twenty seconds later
    answer.resolve({ held: ['a'], cancelling: [] });
    await beating;

    clock.t = 35_000;
    agent.checkLeases();
    expect(c.control.terminate).toHaveBeenCalledWith('a');
  });

  it('never launches a run fenced while its spec was being read', async () => {
    const clock = { t: 0 };
    const q = fakeQueue();
    const c = fakeControl();
    const agent = cutOff(q, c, clock);
    await agent.start();
    const spec = deferred<SealedSpec | null>();
    (q.queue.takeSpec as ReturnType<typeof vi.fn>).mockImplementationOnce(() => spec.promise);

    q.queued.push(run('b'));
    const claiming = agent.wake();
    await flush();
    clock.t = 25_000;
    agent.checkLeases();
    spec.resolve({ specVersion: 1, ciphertext: Buffer.from(JSON.stringify({ simulate: false, spec: {} })) });
    await claiming;

    expect(c.control.launch).not.toHaveBeenCalled();
  });

  it('never launches a run whose claim was answered past its deadline', async () => {
    // The watchdog cannot see a claim in flight; the answer must be judged
    // before the launch, not on the next tick after the run started writing.
    const clock = { t: 0 };
    const q = fakeQueue();
    const c = fakeControl();
    const onFenced = vi.fn();
    const agent = new RunnerAgent({
      queue: q.queue, control: c.control, slots: 1,
      journalPathFor: () => '/j', simulationFixture: () => undefined,
      openSpec: (_o, _r, sealed) => JSON.parse(sealed.ciphertext.toString()) as RunSpecEnvelope,
      pollIntervalMs: 0, heartbeatIntervalMs: 0, leaseCheckIntervalMs: 0, leaseMs: 30_000, fenceMarginMs: 5_000, now: () => clock.t, onFenced,
    });
    await agent.start();
    const claim = deferred<ClaimedRun | null>();
    (q.queue.claimNext as ReturnType<typeof vi.fn>).mockImplementationOnce(() => claim.promise);

    const claiming = agent.wake();
    clock.t = 25_000; // the claim's lease, measured from when it was SENT, is due
    claim.resolve(run('late'));
    await claiming;

    expect(c.control.launch).not.toHaveBeenCalled();
    expect(onFenced).toHaveBeenCalledWith('late');
  });
});

describe('RunnerAgent starting while the database hangs', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('arms the lease watchdog before the first heartbeat, so a hung one cannot shelter recovered runs', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const q = fakeQueue();
    const c = fakeControl();
    c.control.reattach = vi.fn(async () => { c.live.add('old'); return { recovered: 1, settled: 0, following: 1, leased: ['old'] }; });
    // A blackholed connection: the first heartbeat neither answers nor rejects.
    (q.queue.heartbeat as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}));
    const agent = new RunnerAgent({
      queue: q.queue, control: c.control, slots: 1,
      journalPathFor: () => '/j', simulationFixture: () => undefined,
      pollIntervalMs: 0, heartbeatIntervalMs: 0, leaseCheckIntervalMs: 1_000,
    });

    void agent.start();
    await flush();
    expect(c.control.terminate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    expect(c.control.terminate).toHaveBeenCalledWith('old');
    await agent.stop();
  });

  it('arms the watchdog once, however often start is retried', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const q = fakeQueue();
    const c = fakeControl();
    const agent = new RunnerAgent({
      queue: q.queue, control: c.control, slots: 1,
      journalPathFor: () => '/j', simulationFixture: () => undefined,
      pollIntervalMs: 0, heartbeatIntervalMs: 0, leaseCheckIntervalMs: 1_000,
    });
    await agent.start();
    await agent.start();
    expect(vi.getTimerCount()).toBe(1);
    await agent.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('RunnerAgent and the runs it recovered after a restart', () => {
  function recovering(q: ReturnType<typeof fakeQueue>, c: ReturnType<typeof fakeControl>, leased: string[], onFenced = vi.fn()) {
    c.control.reattach = vi.fn(async () => {
      for (const id of leased) c.live.add(id);
      return { recovered: leased.length, settled: 0, following: leased.length, leased };
    });
    return new RunnerAgent({
      queue: q.queue, control: c.control, slots: 2,
      journalPathFor: () => '/j', simulationFixture: () => undefined,
      pollIntervalMs: 0, heartbeatIntervalMs: 0, leaseCheckIntervalMs: 0, onFenced,
    });
  }

  it('fences a recovered run whose lease the sweeper already took', async () => {
    const q = fakeQueue();
    const c = fakeControl();
    const onFenced = vi.fn();
    q.setBeat({ held: [], cancelling: [] });
    await recovering(q, c, ['old'], onFenced).start();
    expect(c.control.terminate).toHaveBeenCalledWith('old');
    expect(onFenced).toHaveBeenCalledWith('old');
  });

  it('keeps a recovered run its heartbeat still holds, and fences it once the lease goes', async () => {
    const q = fakeQueue();
    const c = fakeControl();
    q.setBeat({ held: ['old'], cancelling: [] });
    const agent = recovering(q, c, ['old']);
    await agent.start();
    expect(c.control.terminate).not.toHaveBeenCalled();

    q.setBeat({ held: [], cancelling: [] });
    await agent.beat();
    expect(c.control.terminate).toHaveBeenCalledWith('old');
  });

  it('stops a recovered run when no beat here could confirm its lease', async () => {
    const q = fakeQueue();
    const c = fakeControl();
    (q.queue.heartbeat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNREFUSED'));
    await recovering(q, c, ['old']).start();
    expect(c.control.terminate).toHaveBeenCalledWith('old');
  });
});

describe('RunnerAgent ownership bookkeeping', () => {
  it('forgets a run that finished between two beats, so ownership does not grow with history', async () => {
    const q = fakeQueue([run('a'), run('b'), run('c')]);
    const c = fakeControl();
    const agent = agentWith(q, c);
    const owned = (agent as unknown as { owned: Map<string, number> }).owned;
    q.setBeat({ held: ['a', 'b', 'c'], cancelling: [] });
    await agent.start();
    for (const id of ['a', 'b', 'c']) {
      expect(c.live.has(id)).toBe(true);
      // Finishes, and the next run is claimed, before any beat sees it gone:
      // the run was never live at the start of a beat that missed it.
      c.finish(id);
      await agent.wake();
    }
    await agent.beat();
    expect(owned.size).toBe(0);
    expect(c.control.terminate).not.toHaveBeenCalled();
  });
});

describe('RunnerAgent.cancel', () => {
  it('does nothing for a run this host is not running, leaving it to the runner that is', async () => {
    // RunManager.cancel on an unknown run settles it as gone, which for a run
    // live on another runner would be a lie written into the ledger.
    const q = fakeQueue();
    const c = fakeControl();
    const agent = agentWith(q, c);
    await agent.start();
    expect(await agent.cancel('elsewhere', null)).toBe(false);
    expect(c.control.cancel).not.toHaveBeenCalled();
  });

  it('forwards a cancel for a run live here, with the pid the ledger has', async () => {
    const q = fakeQueue([run('a')]);
    const c = fakeControl();
    const agent = agentWith(q, c);
    await agent.start();
    expect(await agent.cancel('a', 4242)).toBe(true);
    expect(c.control.cancel).toHaveBeenCalledWith('a', 4242);
  });

  it('forwards once when the console and a NOTIFY both deliver the same cancel', async () => {
    const q = fakeQueue([run('a')]);
    const c = fakeControl();
    const agent = agentWith(q, c);
    await agent.start();
    expect(await agent.cancel('a', 4242)).toBe(true);
    expect(await agent.cancel('a')).toBe(true);
    expect(c.control.cancel).toHaveBeenCalledTimes(1);
  });

  it('reports a cancel that failed to forward, and forwards it again on the next beat', async () => {
    // Heartbeats call cancel without awaiting it: a rejection there is an
    // unhandled one, and a run left marked as sent stays `cancelling` forever.
    const q = fakeQueue([run('a')]);
    const c = fakeControl();
    const onError = vi.fn();
    const agent = new RunnerAgent({
      queue: q.queue, control: c.control, slots: 1,
      journalPathFor: () => '/j', simulationFixture: () => undefined,
      openSpec: (_o, _r, s) => JSON.parse(s.ciphertext.toString()),
      pollIntervalMs: 0, heartbeatIntervalMs: 0, onError,
    });
    await agent.start();
    (c.control.cancel as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('channel closed'));

    await expect(agent.cancel('a')).resolves.toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'channel closed' }), 'a');

    q.setBeat({ held: ['a'], cancelling: ['a'] });
    await agent.beat();
    await flush();
    expect(c.control.cancel).toHaveBeenCalledTimes(2);
  });
});

describe('RunnerAgent stopping', () => {
  it('drains: claims nothing more, waits for its runs, then goes offline', async () => {
    const q = fakeQueue([run('a'), run('b')]);
    const c = fakeControl();
    const agent = agentWith(q, c);
    await agent.start();

    const drained = agent.drain(5_000);
    setTimeout(() => c.finish('a'), 50);
    await drained;

    expect(q.states).toEqual(['draining', 'offline']);
    expect(c.launched.map((l) => l.runId)).toEqual(['a']);
    expect(c.control.cancel).not.toHaveBeenCalled();
    expect(c.control.shutdown).toHaveBeenCalled();
  });

  it('gives up waiting at the grace period without cancelling anyone\'s run', async () => {
    const q = fakeQueue([run('a')]);
    const c = fakeControl();
    const agent = agentWith(q, c);
    await agent.start();

    await agent.drain(0);

    expect(c.control.cancel).not.toHaveBeenCalled();
    expect(c.control.terminate).not.toHaveBeenCalled();
    expect(q.states.at(-1)).toBe('offline');
  });

  it('claims nothing once told to stop claiming, while its probes still finish', async () => {
    // A shutdown waits on in-flight probes first; a run claimed meanwhile would
    // be left behind by a drain that has already started.
    const q = fakeQueue();
    const c = fakeControl();
    const agent = agentWith(q, c, 2);
    await agent.start();
    q.queued.push(run('late'));

    await agent.stopClaiming();
    await agent.wake();
    await agent.beat();

    expect(c.launched).toEqual([]);
    expect(q.states).toEqual(['draining']);
  });

  it('drains normally after it stopped claiming, announcing draining once', async () => {
    const q = fakeQueue();
    const c = fakeControl();
    const agent = agentWith(q, c);
    await agent.start();
    await agent.stopClaiming();
    await agent.drain(0);
    expect(q.states).toEqual(['draining', 'offline']);
  });

  it('claims nothing after stop', async () => {
    const q = fakeQueue([run('a')]);
    const c = fakeControl();
    const agent = agentWith(q, c, 0);
    await agent.start();
    await agent.stop();
    (q.queue.claimNext as ReturnType<typeof vi.fn>).mockClear();
    await agent.wake();
    expect(q.queue.claimNext).not.toHaveBeenCalled();
  });
});
