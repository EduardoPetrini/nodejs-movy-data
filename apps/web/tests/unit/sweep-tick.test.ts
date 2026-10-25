import { describe, it, expect, vi } from 'vitest';
import type { SweepResult } from '@movy/runner/agent';
import type { ClassCapacity, RunnerProvisioner } from '../../server/runners/provisioner';
import type { ClassDemand } from '../../server/runners/autoscale';
import { sweepTick, type SweepTickDeps } from '../../server/runners/sweep-tick';

const DEMAND: ClassDemand = { name: 'large', queued: 1, freeSlots: 0, live: 0, maxReplicas: 2 };
const CAPACITY: ClassCapacity = { name: 'large', label: 'Large', maxReplicas: 2, cpuMillis: null, memoryMb: null, liveRunnerIds: [] };

function deps(over: Partial<SweepTickDeps> & { swept?: boolean } = {}) {
  const provisioner: RunnerProvisioner = {
    kind: 'docker',
    scaleUp: vi.fn(async () => ({ status: 'started' as const, runnerClass: 'large', container: 'c1' })),
    cleanup: vi.fn(async () => 0),
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const result: SweepResult = { swept: over.swept ?? true, offlineRunners: [], settledRuns: [] };
  const d: SweepTickDeps = {
    sweep: vi.fn(async () => result),
    provisioner,
    autoscale: true,
    lastScaledAt: new Map(),
    now: () => 1_000_000,
    loadDemand: vi.fn(async () => [DEMAND]),
    loadCapacity: vi.fn(async () => CAPACITY),
    log,
    ...over,
  };
  return { d, provisioner, log };
}

describe('sweepTick', () => {
  it('does nothing but sweep on a replica that lost the sweep lock', async () => {
    // Only the replica that swept tidies and scales: two replicas each starting
    // a runner for the same queued run is the race the lock settles.
    const { d, provisioner } = deps({ swept: false });
    await sweepTick(d);
    expect(provisioner.cleanup).not.toHaveBeenCalled();
    expect(provisioner.scaleUp).not.toHaveBeenCalled();
  });

  it('still scales when removing exited runners fails, and reports it apart', async () => {
    const { d, provisioner, log } = deps();
    (provisioner.cleanup as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('no socket'));
    await sweepTick(d);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('could not remove exited runners'), 'no socket');
    expect(provisioner.scaleUp).toHaveBeenCalledWith(CAPACITY);
  });

  it('retries a failing provisioner once per cooldown, not on every sweep', async () => {
    let now = 1_000_000;
    const { d, provisioner } = deps({ now: () => now });
    (provisioner.scaleUp as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('image missing'));

    await sweepTick(d);
    now += 10_000;
    await sweepTick(d);
    expect(provisioner.scaleUp).toHaveBeenCalledTimes(1);

    now += 60_000;
    await sweepTick(d);
    expect(provisioner.scaleUp).toHaveBeenCalledTimes(2);
  });

  it('starts nothing outside auto mode', async () => {
    const { d, provisioner } = deps({ autoscale: false });
    await sweepTick(d);
    expect(provisioner.cleanup).toHaveBeenCalled();
    expect(provisioner.scaleUp).not.toHaveBeenCalled();
  });

  it('names the runs it settled, since each may be partially applied', async () => {
    const { d, log } = deps({ sweep: vi.fn(async () => ({ swept: true, offlineRunners: ['r-1'], settledRuns: ['run-9'] })) });
    await sweepTick(d);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('run-9'));
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('r-1'));
  });
});
