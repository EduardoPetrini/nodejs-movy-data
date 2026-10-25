import { describe, it, expect } from 'vitest';
import { IdleWatch } from '../../../src/agent/idle-watch';

describe('IdleWatch', () => {
  it('says leave only after a whole idle stretch', () => {
    const watch = new IdleWatch(600_000, 0);
    expect(watch.observe(0, 599_999)).toBe(false);
    expect(watch.observe(0, 600_000)).toBe(true);
  });

  it('starts the stretch over whenever anything ran, a probe included', () => {
    const watch = new IdleWatch(600_000, 0);
    expect(watch.observe(1, 500_000)).toBe(false);
    expect(watch.observe(0, 900_000)).toBe(false);
    expect(watch.observe(0, 1_100_000)).toBe(true);
  });
});
