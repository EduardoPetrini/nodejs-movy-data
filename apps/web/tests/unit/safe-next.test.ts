import { describe, it, expect } from 'vitest';
import { safeNext } from '../../app/utils/safe-next';

describe('safeNext', () => {
  it('passes a path on this site through', () => {
    expect(safeNext('/invite/abc')).toBe('/invite/abc');
    expect(safeNext('/o/acme/runs?tab=log')).toBe('/o/acme/runs?tab=log');
  });

  it('refuses anything that could leave this origin', () => {
    // Someone who has just typed their password must not be handed to another
    // site that looks like this one.
    for (const bad of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      'javascript:alert(1)',
      'o/acme/runs',
      '',
      null,
      undefined,
      42,
    ]) {
      expect(safeNext(bad), String(bad)).toBeUndefined();
    }
  });
});
