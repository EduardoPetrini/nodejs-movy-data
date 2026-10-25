import { describe, it, expect } from 'vitest';
import { AUTOSCALE_COOLDOWN_MS, classesToScale, type ClassDemand } from '../../server/runners/autoscale';

function demand(overrides: Partial<ClassDemand> = {}): ClassDemand {
  return { name: 'large', queued: 1, freeSlots: 0, live: 0, maxReplicas: 1, ...overrides };
}

describe('classesToScale', () => {
  it('starts a runner for queued work that no free slot can take', () => {
    expect(classesToScale([demand()], new Map(), 0)).toEqual(['large']);
  });

  it('leaves a class alone with nothing queued, a free slot, or no room under its cap', () => {
    expect(classesToScale([demand({ queued: 0 })], new Map(), 0)).toEqual([]);
    expect(classesToScale([demand({ freeSlots: 1, live: 1, maxReplicas: 2 })], new Map(), 0)).toEqual([]);
    expect(classesToScale([demand({ live: 1, maxReplicas: 1 })], new Map(), 0)).toEqual([]);
  });

  it('waits out the cooldown, so a runner still registering is not joined by another', () => {
    const last = new Map([['large', 1_000]]);
    expect(classesToScale([demand()], last, 1_000 + AUTOSCALE_COOLDOWN_MS - 1)).toEqual([]);
    expect(classesToScale([demand()], last, 1_000 + AUTOSCALE_COOLDOWN_MS)).toEqual(['large']);
  });

  it('decides each class on its own', () => {
    const out = classesToScale([demand(), demand({ name: 'default', queued: 0 })], new Map(), 0);
    expect(out).toEqual(['large']);
  });
});
