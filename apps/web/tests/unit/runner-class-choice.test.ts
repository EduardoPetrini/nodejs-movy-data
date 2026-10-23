import { describe, it, expect } from 'vitest';
import { chooseRunnerClass, type ConfiguredClass } from '../../server/runners/runner-classes';

const configured: ConfiguredClass[] = [
  { name: 'default', label: 'Default', isDefault: true, suggestAboveBytes: null },
  { name: 'large', label: 'Large', isDefault: false, suggestAboveBytes: 1000 },
];

describe('chooseRunnerClass', () => {
  it('takes the class asked for, over the definition\'s', () => {
    expect(chooseRunnerClass(configured, 'large', 'default')).toEqual({ ok: true, runnerClass: 'large' });
  });

  it('falls back to the definition\'s class, then to the default', () => {
    expect(chooseRunnerClass(configured, undefined, 'large')).toEqual({ ok: true, runnerClass: 'large' });
    expect(chooseRunnerClass(configured, '', null)).toEqual({ ok: true, runnerClass: 'default' });
  });

  it('refuses a class that is not configured when it is asked for', () => {
    expect(chooseRunnerClass(configured, 'huge', null)).toEqual({
      ok: false, statusCode: 422, message: 'There is no runner class "huge" configured.',
    });
    expect(chooseRunnerClass(configured, 42, null)).toMatchObject({ ok: false, statusCode: 400 });
  });

  it('runs a definition whose class was dropped from the file on the default, rather than refusing it', () => {
    expect(chooseRunnerClass(configured, undefined, 'retired')).toEqual({ ok: true, runnerClass: 'default' });
  });

  it('refuses when nothing is configured at all', () => {
    expect(chooseRunnerClass([], undefined, null)).toMatchObject({ ok: false, statusCode: 422 });
  });
});
