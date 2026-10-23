import { describe, it, expect } from 'vitest';
import { availabilityOf, classSentence, type RunnerClassSummary } from '#shared/runner-wire';

function cls(over: Partial<RunnerClassSummary>): RunnerClassSummary {
  return { name: 'default', label: 'Default', description: null, isDefault: true, online: 1, draining: 0, totalSlots: 4, freeSlots: 3, queued: 0, ...over };
}

describe('runner availability wording', () => {
  it('counts free slots when there are some', () => {
    expect(availabilityOf(cls({}))).toBe('free');
    expect(classSentence(cls({}))).toBe('3 of 4 slots free');
  });

  it('says every slot is busy, and how many of this org\'s runs wait', () => {
    const c = cls({ freeSlots: 0, queued: 2 });
    expect(availabilityOf(c)).toBe('busy');
    expect(classSentence(c)).toBe('All 4 slots busy · 2 of your runs waiting');
  });

  it('says so plainly when no runner of the class is online', () => {
    // Not "0 of 0 slots free": nothing will claim a run until one starts.
    const c = cls({ online: 0, totalSlots: 0, freeSlots: 0, queued: 1 });
    expect(availabilityOf(c)).toBe('none');
    expect(classSentence(c)).toBe('No runner online · 1 of your runs waiting');
  });

  it('tells a draining runner apart from a missing one', () => {
    const c = cls({ online: 0, draining: 1, totalSlots: 0, freeSlots: 0 });
    expect(availabilityOf(c)).toBe('draining');
    expect(classSentence(c)).toBe('Draining · finishing its runs, taking no new ones');
  });

  it('uses the singular for one', () => {
    expect(classSentence(cls({ totalSlots: 1, freeSlots: 1 }))).toBe('1 of 1 slot free');
    expect(classSentence(cls({ freeSlots: 0, queued: 1, totalSlots: 1 }))).toBe('Its only slot is busy · 1 of your runs waiting');
  });
});
