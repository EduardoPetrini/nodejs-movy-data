import { describe, it, expect } from 'vitest';
import { viaDisplay } from '#shared/probe-via';

const classes = [{ name: 'default', label: 'Default' }, { name: 'large', label: 'Large' }];

describe('viaDisplay', () => {
  it.each([null, undefined, '', 'web'])('calls %j the console', (via) => {
    expect(viaDisplay(via, classes)).toBe('the console');
  });

  it('names a class by its label', () => {
    expect(viaDisplay('large', classes)).toBe('the Large runner');
  });

  it('keeps the name of a class the console no longer lists — a recorded test is history', () => {
    expect(viaDisplay('retired', classes)).toBe('the retired runner');
  });
});
