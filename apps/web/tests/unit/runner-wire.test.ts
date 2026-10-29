import { describe, it, expect } from 'vitest';
import { availabilityOf, classSentence, scaleSentence, type RunnerClassSummary } from '#shared/runner-wire';

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

describe('scaleSentence', () => {
  it('says what started and when it will show', () => {
    expect(scaleSentence({ status: 'started', runnerClass: 'large', container: 'movy-runner-large-ab12cd' }, 'Large')).toBe(
      'Starting a Large runner (movy-runner-large-ab12cd). It is listed as online once it has registered, usually within a few seconds.'
    );
  });

  it('introduces the command when this deployment starts runners by hand', () => {
    expect(scaleSentence({ status: 'manual', runnerClass: 'large', command: 'x' }, 'Large')).toBe(
      'This deployment starts runners by hand. Run this to start a Large runner:'
    );
  });

  it('names the cap, singular and plural', () => {
    expect(scaleSentence({ status: 'at_capacity', runnerClass: 'large', maxReplicas: 1 }, 'Large')).toContain('limit of 1 runner.');
    expect(scaleSentence({ status: 'at_capacity', runnerClass: 'large', maxReplicas: 3 }, 'Large')).toContain('limit of 3 runners.');
  });

  it('explains an on-demand class instead of pretending to start one, with how many are starting', () => {
    const sentence = (starting: number) => scaleSentence({ status: 'on_demand', runnerClass: 'large', starting }, 'Large');
    expect(sentence(0)).toBe('The Large class starts a runner for each queued run. None is starting now.');
    expect(sentence(1)).toBe('The Large class starts a runner for each queued run. 1 is starting now.');
    expect(sentence(2)).toBe('The Large class starts a runner for each queued run. 2 are starting now.');
  });
});
